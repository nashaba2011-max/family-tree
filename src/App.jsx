import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import {
  Plus, X, Search, Trash2, Pencil, GitBranch, Users2, ZoomIn, ZoomOut,
  Maximize2, Link2, Download, Upload, Camera, Crosshair, ListTree, ChevronRight,
  LogOut, ShieldCheck,
} from "lucide-react";

const STORE_KEY = "familyRegister:v2";
const AUTH_KEY = "familyRegisterAuth:v1";
/* Client-side only — no backend. This is an access gate against casual
   opening on a shared device, not real security: anyone with devtools can
   read this constant or edit localStorage directly. */
const ADMIN_PASSWORD = "123456";

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const hashPassword = (name, password) => sha256Hex(`${name.trim().toLowerCase()}::${password}`);

/* Browser storage. Kept behind a tiny async wrapper so the app code
   doesn't care where the register actually lives. */
const store = {
  async get(key) {
    const value = localStorage.getItem(key);
    return value === null ? null : { key, value };
  },
  async set(key, value) {
    localStorage.setItem(key, value);
    return { key, value };
  },
  /* Private browsing (older Safari/Firefox) and "block all site data"
     settings can make localStorage exist but throw on every call, so a
     real read/write round-trip is the only reliable availability check. */
  isAvailable() {
    try {
      const probe = "__familyRegister_probe__";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  },
};

/* ---------------- data helpers ---------------- */

const makeId = () => "p" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
const fullName = (p) => `${p.firstName}${p.lastName ? " " + p.lastName : ""}`.trim();
const years = (p) => (!p.birthYear && !p.deathYear ? "لا توجد تواريخ مسجَّلة" : `${p.birthYear || "؟"} – ${p.deathYear || "حتى الآن"}`);
const initials = (p) => ((p.firstName || "")[0] || "") + ((p.lastName || "")[0] || "");
const uniq = (a) => Array.from(new Set(a));

/* Arabic number agreement: 0 -> "لا يوجد"، 1 -> singular، 2 -> dual، 3-10 -> plural، 11+ -> singular (تمييز) */
function countPhrase(n, singular, dual, plural) {
  if (n === 0) return `لا يوجد ${plural}`;
  if (n === 1) return `${singular} واحد`;
  if (n === 2) return dual;
  if (n >= 3 && n <= 10) return `${n} ${plural}`;
  return `${n} ${singular}`;
}

function normalize(p) {
  return {
    id: p.id || makeId(),
    firstName: p.firstName || "",
    lastName: p.lastName || "",
    birthYear: p.birthYear || "",
    deathYear: p.deathYear || "",
    notes: p.notes || "",
    photo: p.photo || null,
    parentIds: Array.isArray(p.parentIds) ? p.parentIds : [],
    spouseIds: Array.isArray(p.spouseIds) ? p.spouseIds : [],
    siblingIds: Array.isArray(p.siblingIds) ? p.siblingIds : [],
  };
}

/* Siblings linked directly share one "effective" parent set, so sibling links
   still work when no parents have been recorded yet. */
function effectiveParentsMap(people) {
  const byId = Object.fromEntries(people.map((p) => [p.id, p]));
  const root = {};
  const find = (x) => {
    if (root[x] === undefined) root[x] = x;
    return root[x] === x ? x : (root[x] = find(root[x]));
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) root[ra] = rb;
  };
  people.forEach((p) => {
    find(p.id);
    (p.siblingIds || []).forEach((s) => byId[s] && union(p.id, s));
  });
  const groupParents = {};
  people.forEach((p) => {
    const g = find(p.id);
    groupParents[g] = uniq([...(groupParents[g] || []), ...p.parentIds.filter((id) => byId[id])]);
  });
  const map = {};
  people.forEach((p) => { map[p.id] = groupParents[find(p.id)] || []; });
  return { map, groupOf: (id) => find(id) };
}

function ancestorsOf(id, effParents) {
  const out = { [id]: { dist: 0, path: [id] } };
  const q = [id];
  while (q.length) {
    const cur = q.shift();
    (effParents[cur] || []).forEach((pid) => {
      if (!(pid in out)) {
        out[pid] = { dist: out[cur].dist + 1, path: [...out[cur].path, pid] };
        q.push(pid);
      }
    });
  }
  return out;
}

/* Arabic relationship labels. The data model has no gender field, so
   ambiguous terms are given as neutral "X or Y" pairs, matching the
   original English app's own approach (e.g. "aunt or uncle"). */
const ordinalAr = (n) => {
  const words = ["", "الأولى", "الثانية", "الثالثة", "الرابعة", "الخامسة", "السادسة", "السابعة", "الثامنة", "التاسعة", "العاشرة"];
  return words[n] || `رقم ${n}`;
};
const ancLabel = (d) => {
  if (d === 1) return "أحد الوالدين";
  if (d === 2) return "الجد أو الجدة";
  return `أحد الأجداد (الجيل ${d})`;
};
const descLabel = (d) => {
  if (d === 1) return "أحد الأبناء";
  if (d === 2) return "أحد الأحفاد";
  return `أحد الأحفاد (الجيل ${d})`;
};
const niblingLabel = (db) => (db === 2 ? "ابن/ابنة الأخ أو الأخت" : `أحد نسل الأخ أو الأخت (الجيل ${db})`);
const auntUncleLabel = (da) => (da === 2 ? "العم/العمة أو الخال/الخالة" : `أحد أقارب جيل الإخوة (الدرجة ${da})`);
const cousinLabel = (deg, removed) => {
  const base = `ابن/ابنة عم أو خال من الدرجة ${ordinalAr(deg)}`;
  if (removed === 0) return base;
  if (removed === 1) return `${base}، بإزاحة جيل واحد`;
  if (removed === 2) return `${base}، بإزاحة جيلين`;
  return `${base}، بإزاحة ${removed} أجيال`;
};

function bloodRelation(aId, bId, effParents, groupOf) {
  if (aId === bId) return null;
  if (groupOf(aId) === groupOf(bId) && (effParents[aId] || []).length === 0) {
    return { label: "أخ أو أخت", path: [aId, bId] };
  }
  const A = ancestorsOf(aId, effParents), B = ancestorsOf(bId, effParents);
  let best = null;
  for (const cid in A) {
    if (cid in B) {
      const total = A[cid].dist + B[cid].dist;
      if (!best || total < best.total) best = { da: A[cid].dist, db: B[cid].dist, total, pa: A[cid].path, pb: B[cid].path };
    }
  }
  if (!best) return null;
  const { da, db, pa, pb } = best;
  let label;
  if (da === 0) label = descLabel(db);
  else if (db === 0) label = ancLabel(da);
  else if (da === 1 && db === 1) label = "أخ أو أخت";
  else if (da === 1) label = niblingLabel(db);
  else if (db === 1) label = auntUncleLabel(da);
  else {
    const deg = Math.min(da, db) - 1, rem = Math.abs(da - db);
    label = cousinLabel(deg, rem);
  }
  return { label, path: [...pa, ...pb.slice(0, -1).reverse()] };
}

function computeRelationship(aId, bId, people) {
  const byId = Object.fromEntries(people.map((p) => [p.id, p]));
  const a = byId[aId], b = byId[bId];
  if (!a || !b || aId === bId) return null;
  const { map: eff, groupOf } = effectiveParentsMap(people);

  const blood = bloodRelation(aId, bId, eff, groupOf);
  if (blood) return { label: blood.label, path: blood.path.map((id) => byId[id]) };
  if (a.spouseIds.includes(bId)) return { label: "زوج أو زوجة", path: [a, b] };

  for (const sid of a.spouseIds) {
    const r = byId[sid] && bloodRelation(sid, bId, eff, groupOf);
    if (r) return { label: `${r.label} بالمصاهرة`, path: [a, ...r.path.map((id) => byId[id])] };
  }
  for (const sid of b.spouseIds) {
    const r = byId[sid] && bloodRelation(aId, sid, eff, groupOf);
    if (r) return { label: `${r.label} بالمصاهرة`, path: [...r.path.map((id) => byId[id]), b] };
  }
  return { label: null, path: [a, b] };
}

/* ---------------- linking, with guardrails ---------------- */

function isAncestor(candidateId, ofId, people) {
  const { map: eff } = effectiveParentsMap(people);
  return candidateId !== ofId && candidateId in ancestorsOf(ofId, eff);
}

/** type 'parent' means: aId is the parent of bId */
function linkPeople(people, type, aId, bId) {
  if (!aId || !bId || aId === bId) return { error: "اختر شخصين مختلفين." };
  const byId = Object.fromEntries(people.map((p) => [p.id, p]));
  if (!byId[aId] || !byId[bId]) return { error: "هذان الشخصان لم يعودا موجودين في السجل." };

  if (type === "parent") {
    if (byId[bId].parentIds.includes(aId)) return { error: `${fullName(byId[aId])} مسجَّل بالفعل كأحد الوالدين.` };
    if (isAncestor(bId, aId, people)) return { error: "هذا سيجعل الشخص جدًا لنفسه — وهو أمر غير ممكن." };
    if (byId[bId].parentIds.length >= 2) return { error: `${fullName(byId[bId])} لديه بالفعل والدان مسجَّلان. احذف أحدهما أولًا.` };
    return { people: people.map((p) => (p.id === bId ? { ...p, parentIds: uniq([...p.parentIds, aId]) } : p)) };
  }
  if (type === "spouse") {
    if (byId[aId].spouseIds.includes(bId)) return { error: "هما مسجَّلان بالفعل كزوجين." };
    return {
      people: people.map((p) => {
        if (p.id === aId) return { ...p, spouseIds: uniq([...p.spouseIds, bId]) };
        if (p.id === bId) return { ...p, spouseIds: uniq([...p.spouseIds, aId]) };
        return p;
      }),
    };
  }
  if (type === "sibling") {
    const shared = uniq([...byId[aId].parentIds, ...byId[bId].parentIds]);
    if (shared.length > 2) return { error: "عدد الوالدين المسجَّلين يمنع ربطهما كأخوين." };
    return {
      people: people.map((p) => {
        if (p.id === aId) return { ...p, parentIds: shared, siblingIds: uniq([...p.siblingIds, bId]) };
        if (p.id === bId) return { ...p, parentIds: shared, siblingIds: uniq([...p.siblingIds, aId]) };
        return p;
      }),
    };
  }
  return { error: "نوع علاقة غير معروف." };
}

function unlink(people, type, aId, bId) {
  return people.map((p) => {
    if (type === "parent" && p.id === bId) return { ...p, parentIds: p.parentIds.filter((x) => x !== aId) };
    if (type === "spouse" && (p.id === aId || p.id === bId))
      return { ...p, spouseIds: p.spouseIds.filter((x) => x !== (p.id === aId ? bId : aId)) };
    if (type === "sibling" && (p.id === aId || p.id === bId))
      return { ...p, siblingIds: p.siblingIds.filter((x) => x !== (p.id === aId ? bId : aId)) };
    return p;
  });
}

/* ---------------- layout ---------------- */

const NODE_W = 168, NODE_H = 74, X_GAP = 30, Y_GAP = 96, MARGIN = 40;

function computeLayout(people) {
  if (!people.length) return { nodes: [], childEdges: [], spouseEdges: [], sibEdges: [], width: 0, height: 0 };
  const byId = Object.fromEntries(people.map((p) => [p.id, p]));
  const { map: eff } = effectiveParentsMap(people);
  const childrenOf = {};
  people.forEach((p) => (eff[p.id] || []).forEach((pid) => { childrenOf[pid] = [...(childrenOf[pid] || []), p.id]; }));

  const gen = {};
  const spread = (startId) => {
    gen[startId] = 0;
    let changed = true, guard = 0;
    while (changed && guard++ < people.length * 3 + 5) {
      changed = false;
      people.forEach((p) => {
        if (!(p.id in gen)) return;
        const g = gen[p.id];
        (eff[p.id] || []).forEach((pid) => {
          if (byId[pid] && gen[pid] === undefined) { gen[pid] = g - 1; changed = true; }
        });
        (childrenOf[p.id] || []).forEach((cid) => {
          if (gen[cid] === undefined) { gen[cid] = g + 1; changed = true; }
        });
        [...p.spouseIds, ...p.siblingIds].forEach((oid) => {
          if (byId[oid] && gen[oid] === undefined) { gen[oid] = g; changed = true; }
        });
      });
    }
  };
  people.forEach((p) => { if (!(p.id in gen)) spread(p.id); });

  const minG = Math.min(...Object.values(gen));
  Object.keys(gen).forEach((k) => { gen[k] -= minG; });

  const byGen = {};
  people.forEach((p) => { byGen[gen[p.id]] = [...(byGen[gen[p.id]] || []), p.id]; });
  const levels = Object.keys(byGen).map(Number).sort((a, b) => a - b);

  const xPos = {};
  levels.forEach((g, gi) => {
    const ids = byGen[g].slice();
    if (gi === 0) ids.sort((x, y) => fullName(byId[x]).localeCompare(fullName(byId[y])));
    else {
      const key = (id) => {
        const px = (eff[id] || []).map((pid) => xPos[pid]).filter((v) => v !== undefined);
        return px.length ? px.reduce((s, v) => s + v, 0) / px.length : Number.MAX_SAFE_INTEGER;
      };
      ids.sort((x, y) => key(x) - key(y) || fullName(byId[x]).localeCompare(fullName(byId[y])));
    }
    const ordered = [], placed = new Set();
    ids.forEach((id) => {
      if (placed.has(id)) return;
      ordered.push(id); placed.add(id);
      byId[id].spouseIds.forEach((sid) => {
        if (byId[sid] && gen[sid] === g && !placed.has(sid)) { ordered.push(sid); placed.add(sid); }
      });
    });
    ordered.forEach((id, i) => { xPos[id] = MARGIN + i * (NODE_W + X_GAP); });
  });

  const nodes = people.map((p, i) => ({
    ...p, recordNo: i + 1,
    x: xPos[p.id] ?? MARGIN,
    y: MARGIN + gen[p.id] * (NODE_H + Y_GAP),
  }));
  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));

  const childEdges = [];
  people.forEach((p) => {
    const parents = p.parentIds.filter((id) => nodeById[id]);
    const child = nodeById[p.id];
    if (!child || !parents.length) return;
    if (parents.length >= 2) {
      const p1 = nodeById[parents[0]], p2 = nodeById[parents[1]];
      childEdges.push({
        from: { x: (p1.x + p2.x) / 2 + NODE_W / 2, y: Math.max(p1.y, p2.y) + NODE_H },
        to: { x: child.x + NODE_W / 2, y: child.y },
      });
    } else {
      const par = nodeById[parents[0]];
      childEdges.push({ from: { x: par.x + NODE_W / 2, y: par.y + NODE_H }, to: { x: child.x + NODE_W / 2, y: child.y } });
    }
  });

  const spouseEdges = [], sibEdges = [], seen = new Set();
  people.forEach((p) => {
    p.spouseIds.forEach((sid) => {
      const k = "s" + [p.id, sid].sort().join("|");
      if (seen.has(k) || !nodeById[sid]) return;
      seen.add(k);
      spouseEdges.push({ a: nodeById[p.id], b: nodeById[sid] });
    });
    p.siblingIds.forEach((sid) => {
      const k = "b" + [p.id, sid].sort().join("|");
      if (seen.has(k) || !nodeById[sid] || p.parentIds.length) return;
      seen.add(k);
      sibEdges.push({ a: nodeById[p.id], b: nodeById[sid] });
    });
  });

  return {
    nodes, childEdges, spouseEdges, sibEdges,
    width: Math.max(...nodes.map((n) => n.x)) + NODE_W + MARGIN,
    height: Math.max(...nodes.map((n) => n.y)) + NODE_H + MARGIN,
  };
}

function focusSubset(people, focusId) {
  if (!focusId) return people;
  const byId = Object.fromEntries(people.map((p) => [p.id, p]));
  if (!byId[focusId]) return people;
  const { map: eff } = effectiveParentsMap(people);
  const keep = new Set([focusId]);
  Object.keys(ancestorsOf(focusId, eff)).forEach((id) => keep.add(id));
  const down = [focusId];
  while (down.length) {
    const cur = down.shift();
    people.forEach((p) => {
      if ((eff[p.id] || []).includes(cur) && !keep.has(p.id)) { keep.add(p.id); down.push(p.id); }
    });
  }
  Array.from(keep).forEach((id) => (byId[id]?.spouseIds || []).forEach((s) => byId[s] && keep.add(s)));
  return people.filter((p) => keep.has(p.id));
}

const curve = (f, t) => `M ${f.x} ${f.y} C ${f.x} ${(f.y + t.y) / 2}, ${t.x} ${(f.y + t.y) / 2}, ${t.x} ${t.y}`;

/* ---------------- photos ---------------- */

function readPhoto(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 240;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", 0.72));
      };
      img.onerror = () => reject(new Error("bad image"));
      img.src = fr.result;
    };
    fr.onerror = () => reject(new Error("read failed"));
    fr.readAsDataURL(file);
  });
}

/* ---------------- app ---------------- */

export default function App() {
  const [people, setPeople] = useState([]);
  const [familyName, setFamilyName] = useState("عائلة النشابة");
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("tree");
  const [selectedId, setSelectedId] = useState(null);
  const [focusId, setFocusId] = useState(null);
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState(null);
  const [relA, setRelA] = useState(null);
  const [relB, setRelB] = useState(null);
  const [toast, setToast] = useState(null);
  const [auth, setAuth] = useState({ users: [], session: null });
  const [authLoaded, setAuthLoaded] = useState(false);
  const importRef = useRef(null);

  const say = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const r = await store.get(AUTH_KEY);
        if (r?.value) {
          const d = JSON.parse(r.value);
          setAuth({ users: Array.isArray(d.users) ? d.users : [], session: d.session || null });
        }
      } catch { /* nothing saved yet */ }
      setAuthLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!authLoaded) return;
    store.set(AUTH_KEY, JSON.stringify(auth)).catch(() => {});
  }, [auth, authLoaded]);

  useEffect(() => {
    (async () => {
      if (!store.isAvailable()) {
        say("التصفح الخاص أو إعداد يحظر تخزين بيانات الموقع يعني أن التعديلات لن تُحفظ.");
      }
      try {
        const r = await store.get(STORE_KEY);
        if (r?.value) {
          const d = JSON.parse(r.value);
          if (Array.isArray(d.people)) setPeople(d.people.map(normalize));
          if (d.familyName) setFamilyName(d.familyName);
        }
      } catch (e) { /* nothing saved yet */ }
      setLoaded(true);
    })();
  }, [say]);

  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      store.set(STORE_KEY, JSON.stringify({ people, familyName }))
        .catch((e) => say(
          e?.name === "QuotaExceededError"
            ? "تعذّر الحفظ — قد يكون السجل كبيرًا جدًا. جرّب حذف صورة كبيرة الحجم."
            : "تعذّر الحفظ — قد يكون السبب التصفح الخاص أو حظر التخزين."
        ));
    }, 400);
    return () => clearTimeout(t);
  }, [people, familyName, loaded, say]);

  const byId = useMemo(() => Object.fromEntries(people.map((p) => [p.id, p])), [people]);
  const shown = useMemo(() => focusSubset(people, focusId), [people, focusId]);
  const layout = useMemo(() => computeLayout(shown), [shown]);
  const selected = selectedId ? byId[selectedId] : null;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? people.filter((p) => fullName(p).toLowerCase().includes(q)) : people;
    return list.slice().sort((a, b) => fullName(a).localeCompare(fullName(b)));
  }, [people, query]);

  function savePerson(form) {
    if (form.editId) {
      setPeople((prev) => prev.map((p) => (p.id === form.editId ? { ...p, ...form.fields } : p)));
      setModal(null);
      return;
    }
    const person = normalize({ ...form.fields, id: makeId() });
    setPeople((prev) => {
      let next = [...prev, person];
      const { relationType: rt, relatedId, secondParentId } = form;
      if (relatedId && prev.length) {
        const apply = (type, a, b) => {
          const res = linkPeople(next, type, a, b);
          if (res.error) say(res.error);
          else next = res.people;
        };
        if (rt === "parent") apply("parent", person.id, relatedId);
        if (rt === "child") {
          apply("parent", relatedId, person.id);
          if (secondParentId) apply("parent", secondParentId, person.id);
        }
        if (rt === "spouse") apply("spouse", person.id, relatedId);
        if (rt === "sibling") apply("sibling", person.id, relatedId);
      }
      return next;
    });
    setSelectedId(person.id);
    setModal(null);
  }

  function doLink(type, a, b) {
    const res = linkPeople(people, type, a, b);
    if (res.error) { say(res.error); return false; }
    setPeople(res.people);
    say("تم الربط.");
    return true;
  }

  function removePerson(id) {
    setPeople((prev) =>
      prev.filter((p) => p.id !== id).map((p) => ({
        ...p,
        parentIds: p.parentIds.filter((x) => x !== id),
        spouseIds: p.spouseIds.filter((x) => x !== id),
        siblingIds: p.siblingIds.filter((x) => x !== id),
      }))
    );
    if (selectedId === id) setSelectedId(null);
    if (focusId === id) setFocusId(null);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ familyName, people, exportedAt: new Date().toISOString() }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(familyName || "family").replace(/\s+/g, "-").toLowerCase()}-register.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importJson(file) {
    try {
      const d = JSON.parse(await file.text());
      if (!Array.isArray(d.people)) throw new Error("shape");
      setPeople(d.people.map(normalize));
      if (d.familyName) setFamilyName(d.familyName);
      setSelectedId(null); setFocusId(null);
      say(`تم تحميل ${countPhrase(d.people.length, "سجل", "سجلّان", "سجلات")}.`);
    } catch {
      say("هذا الملف ليس نسخة مُصدَّرة من السجل.");
    }
  }

  const relationResult = relA && relB && relA !== relB ? computeRelationship(relA, relB, people) : null;

  if (!authLoaded) return null;

  if (!auth.session) {
    return <AuthGate auth={auth} setAuth={setAuth} familyName={familyName} />;
  }

  return (
    <div className="fr" dir="rtl" lang="ar">
      <style>{CSS}</style>

      <header className="fr-head">
        <div className="fr-head-in">
          {focusId ? (
            <button className="fr-back" onClick={() => setFocusId(null)}>
              <ChevronRight size={16} /> الشجرة كاملة
            </button>
          ) : (
            <div className="fr-title">
              <input value={familyName} onChange={(e) => setFamilyName(e.target.value)} aria-label="اسم العائلة" />
              <p>{`أهلًا ${auth.session.name} • ${countPhrase(people.length, "فرد", "فردان", "أفراد")}`}</p>
            </div>
          )}
          <div className="fr-head-tools">
            <button className="fr-ib" title="حفظ نسخة" onClick={exportJson}><Download size={17} /></button>
            <button className="fr-ib" title="تحميل نسخة محفوظة" onClick={() => importRef.current?.click()}><Upload size={17} /></button>
            <input ref={importRef} type="file" accept="application/json" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ""; }} />
            <button className="fr-ib" title="ربط شخصين" disabled={people.length < 2}
              onClick={() => setModal({ mode: "link" })}><Link2 size={17} /></button>
            {auth.session.isAdmin && (
              <button className="fr-ib" title="إدارة المستخدمين" onClick={() => setModal({ mode: "users" })}><ShieldCheck size={17} /></button>
            )}
            <button className="fr-ib" title="تسجيل الخروج" onClick={() => setAuth((a) => ({ ...a, session: null }))}><LogOut size={17} /></button>
          </div>
        </div>
        {focusId && byId[focusId] && <p className="fr-focus-note">عرض نسب {fullName(byId[focusId])}</p>}
      </header>

      <nav className="fr-nav">
        <button className={view === "tree" ? "on" : ""} onClick={() => setView("tree")}><GitBranch size={19} /><span>الشجرة</span></button>
        <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}><ListTree size={19} /><span>السجل</span></button>
        <button className={view === "connect" ? "on" : ""} onClick={() => setView("connect")}><Users2 size={19} /><span>القرابة</span></button>
      </nav>

      <main className="fr-main">
        {view === "tree" && (
          <TreeCanvas layout={layout} selectedId={selectedId} onSelect={setSelectedId} empty={people.length === 0}
            onAddFirst={() => setModal({ mode: "add", relationType: "root" })} />
        )}

        {view === "list" && (
          <div className="fr-list">
            <div className="fr-search">
              <Search size={15} />
              <input placeholder="ابحث في السجل" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            {filtered.length === 0 ? (
              <p className="fr-muted">{people.length ? "لا توجد نتائج مطابقة." : "لا يوجد أي سجلات بعد."}</p>
            ) : (
              <ul>
                {filtered.map((p) => (
                  <li key={p.id} onClick={() => { setSelectedId(p.id); setView("tree"); }}>
                    <Avatar p={p} size={38} />
                    <div>
                      <div className="nm">{fullName(p)}</div>
                      <div className="yr">{years(p)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {view === "connect" && (
          <div className="fr-connect">
            <h2>ما صلة القرابة بينهما؟</h2>
            <p className="fr-muted">اختر شخصين لتتبّع صلة القرابة بينهما.</p>
            <select value={relA || ""} onChange={(e) => setRelA(e.target.value || null)}>
              <option value="">اختر شخصًا…</option>
              {people.map((p) => <option key={p.id} value={p.id}>{fullName(p)}</option>)}
            </select>
            <div className="fr-and">و</div>
            <select value={relB || ""} onChange={(e) => setRelB(e.target.value || null)}>
              <option value="">اختر شخصًا…</option>
              {people.map((p) => <option key={p.id} value={p.id}>{fullName(p)}</option>)}
            </select>
            {relationResult && (
              <div className="fr-result">
                {relationResult.label ? (
                  <>
                    <p className="rel">صلة قرابة {fullName(byId[relB])} بـ {fullName(byId[relA])}: <b>{relationResult.label}</b></p>
                    <p className="path">
                      {relationResult.path.map((p, i) => (
                        <span key={p.id + i}>{fullName(p)}{i < relationResult.path.length - 1 ? " ← " : ""}</span>
                      ))}
                    </p>
                  </>
                ) : (
                  <p className="rel">لا توجد صلة قرابة مسجَّلة بينهما حتى الآن.</p>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      {view === "tree" && people.length > 0 && (
        <button className="fr-fab" aria-label="إضافة فرد للعائلة"
          onClick={() => setModal({ mode: "add", relationType: "child", relatedId: selectedId })}>
          <Plus size={22} />
        </button>
      )}

      {selected && view === "tree" && (
        <Sheet
          person={selected} people={people} byId={byId}
          onClose={() => setSelectedId(null)}
          onPick={setSelectedId}
          onAdd={(rt) => setModal({ mode: "add", relationType: rt, relatedId: selected.id })}
          onEdit={() => setModal({ mode: "edit", person: selected })}
          onFocus={() => setFocusId(selected.id)}
          onRemove={() => removePerson(selected.id)}
          onUnlink={(type, a, b) => setPeople(unlink(people, type, a, b))}
        />
      )}

      {modal && modal.mode === "users" ? (
        <UsersPanel users={auth.users} onClose={() => setModal(null)}
          onRemove={(name) => setAuth((a) => ({ ...a, users: a.users.filter((u) => u.name !== name) }))} />
      ) : (
        modal && <Dialog modal={modal} people={people} onClose={() => setModal(null)} onSave={savePerson} onLink={doLink} say={say} />
      )}
      {toast && <div className="fr-toast">{toast}</div>}
    </div>
  );
}

/* ---------------- auth ---------------- */

function AuthGate({ auth, setAuth, familyName }) {
  const [tab, setTab] = useState("login");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setError("");
    const n = name.trim();

    if (tab === "admin") {
      if (password !== ADMIN_PASSWORD) { setError("كلمة مرور المسؤول غير صحيحة."); return; }
      setAuth((a) => ({ ...a, session: { name: n || "المسؤول", isAdmin: true } }));
      return;
    }
    if (!n) { setError("الاسم مطلوب."); return; }

    if (tab === "register") {
      if (password.length < 4) { setError("كلمة المرور يجب أن تكون 4 أحرف على الأقل."); return; }
      if (password !== confirm) { setError("كلمتا المرور غير متطابقتين."); return; }
      if (auth.users.some((u) => u.name.toLowerCase() === n.toLowerCase())) {
        setError("هذا الاسم مسجَّل بالفعل. جرّب تسجيل الدخول بدلًا من ذلك."); return;
      }
      setBusy(true);
      const hash = await hashPassword(n, password);
      setBusy(false);
      setAuth((a) => ({ ...a, users: [...a.users, { name: n, hash }], session: { name: n, isAdmin: false } }));
      return;
    }

    const user = auth.users.find((u) => u.name.toLowerCase() === n.toLowerCase());
    if (!user) { setError("لا يوجد مستخدم بهذا الاسم. سجّل حسابًا جديدًا."); return; }
    setBusy(true);
    const hash = await hashPassword(n, password);
    setBusy(false);
    if (hash !== user.hash) { setError("كلمة المرور غير صحيحة."); return; }
    setAuth((a) => ({ ...a, session: { name: user.name, isAdmin: false } }));
  }

  return (
    <div className="fr fr-auth" dir="rtl" lang="ar">
      <style>{CSS}</style>
      <div className="fr-auth-card">
        <h1>{familyName || "السجل العائلي"}</h1>
        <p className="fr-muted">سجّل اسمك لدخول السجل العائلي.</p>

        <div className="fr-auth-tabs">
          <button type="button" className={tab === "login" ? "on" : ""} onClick={() => { setTab("login"); setError(""); }}>تسجيل الدخول</button>
          <button type="button" className={tab === "register" ? "on" : ""} onClick={() => { setTab("register"); setError(""); }}>حساب جديد</button>
          <button type="button" className={tab === "admin" ? "on" : ""} onClick={() => { setTab("admin"); setError(""); }}>دخول كمسؤول</button>
        </div>

        <form onSubmit={submit}>
          <div className="fr-field">
            <label>{tab === "admin" ? "اسمك (اختياري)" : "الاسم"}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="fr-field">
            <label>{tab === "admin" ? "كلمة مرور المسؤول" : "كلمة المرور"}</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {tab === "register" && (
            <div className="fr-field">
              <label>تأكيد كلمة المرور</label>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
          )}
          {error && <p className="fr-auth-error">{error}</p>}
          <button className="fr-primary" type="submit" disabled={busy}>
            {tab === "register" ? "إنشاء الحساب" : "دخول"}
          </button>
        </form>
      </div>
    </div>
  );
}

function UsersPanel({ users, onClose, onRemove }) {
  return (
    <div className="fr-modal-bg" onClick={onClose}>
      <div className="fr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fr-modal-head">
          <h3>إدارة المستخدمين</h3>
          <button className="fr-ib" onClick={onClose} aria-label="إغلاق"><X size={20} /></button>
        </div>
        {users.length === 0 ? (
          <p className="fr-muted">لا يوجد مستخدمون مسجَّلون بعد.</p>
        ) : (
          <div className="fr-group">
            {users.map((u) => (
              <span key={u.name} className="fr-chip">
                <span>{u.name}</span>
                <button onClick={() => onRemove(u.name)} aria-label={`حذف ${u.name}`}><X size={12} /></button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- pieces ---------------- */

function Avatar({ p, size = 40 }) {
  return p.photo ? (
    <img className="fr-av" src={p.photo} alt="" style={{ width: size, height: size }} />
  ) : (
    <div className="fr-av fr-av-ph" style={{ width: size, height: size, fontSize: size * 0.36 }}>{initials(p)}</div>
  );
}

function TreeCanvas({ layout, selectedId, onSelect, empty, onAddFirst }) {
  const wrap = useRef(null);
  const [t, setT] = useState({ x: 0, y: 0, s: 1 });
  const pointers = useRef(new Map());
  const gesture = useRef({ moved: false, lastDist: 0 });

  const fit = useCallback(() => {
    const el = wrap.current;
    if (!el || !layout.width) return;
    const s = Math.min(1, Math.min(el.clientWidth / layout.width, el.clientHeight / layout.height) * 0.92);
    setT({ s, x: (el.clientWidth - layout.width * s) / 2, y: 16 });
  }, [layout.width, layout.height]);

  useEffect(() => { fit(); }, [fit]);

  const zoomAt = (cx, cy, ratio) => {
    setT((prev) => {
      const s = Math.max(0.25, Math.min(2.5, prev.s * ratio));
      const k = s / prev.s;
      return { s, x: cx - (cx - prev.x) * k, y: cy - (cy - prev.y) * k };
    });
  };
  const zoomCenter = (ratio) => {
    const el = wrap.current;
    if (el) zoomAt(el.clientWidth / 2, el.clientHeight / 2, ratio);
  };

  const onDown = (e) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture.current.moved = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = Array.from(pointers.current.values());
    if (pts.length >= 2) {
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const rect = wrap.current.getBoundingClientRect();
      const mx = (pts[0].x + pts[1].x) / 2 - rect.left, my = (pts[0].y + pts[1].y) / 2 - rect.top;
      if (gesture.current.lastDist) zoomAt(mx, my, d / gesture.current.lastDist);
      gesture.current.lastDist = d;
      gesture.current.moved = true;
      return;
    }
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) gesture.current.moved = true;
    setT((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
  };
  const onUp = (e) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current.lastDist = 0;
  };
  const onWheel = (e) => {
    const rect = wrap.current.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 0.89);
  };

  if (empty) {
    return (
      <div className="fr-blank">
        <h2>ابدأ السجل</h2>
        <p>أضف أول فرد في عائلتك، وستتفرّع الشجرة من هناك تلقائيًا.</p>
        <button className="fr-primary" onClick={onAddFirst}><Plus size={16} /> إضافة أول فرد</button>
      </div>
    );
  }

  return (
    <div className="fr-canvas-wrap">
      <div ref={wrap} className="fr-canvas" onPointerDown={onDown} onPointerMove={onMove}
        onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel}>
        <div className="fr-stage" style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`, width: layout.width, height: layout.height }}>
          <svg width={layout.width} height={layout.height} className="fr-edges">
            {layout.childEdges.map((e, i) => <path key={"c" + i} d={curve(e.from, e.to)} className="e-child" />)}
            {layout.spouseEdges.map((e, i) => {
              const left = e.a.x <= e.b.x ? e.a : e.b, right = e.a.x <= e.b.x ? e.b : e.a;
              if (left.y !== right.y) return null;
              const y = left.y + NODE_H / 2;
              return <line key={"s" + i} x1={left.x + NODE_W} y1={y} x2={right.x} y2={y} className="e-spouse" />;
            })}
            {layout.sibEdges.map((e, i) => {
              const left = e.a.x <= e.b.x ? e.a : e.b, right = e.a.x <= e.b.x ? e.b : e.a;
              const y = Math.min(left.y, right.y) - 14;
              return <path key={"b" + i} className="e-sib"
                d={`M ${left.x + NODE_W / 2} ${left.y} V ${y} H ${right.x + NODE_W / 2} V ${right.y}`} />;
            })}
          </svg>
          {layout.nodes.map((n) => (
            <div key={n.id} className={"fr-node" + (selectedId === n.id ? " on" : "")}
              style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
              onClick={() => { if (!gesture.current.moved) onSelect(n.id); }}>
              <Avatar p={n} size={40} />
              <div className="fr-node-txt">
                <div className="nm">{fullName(n)}</div>
                <div className="yr">{years(n)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="fr-zoom">
        <button onClick={() => zoomCenter(1.2)} aria-label="تكبير"><ZoomIn size={17} /></button>
        <button onClick={() => zoomCenter(0.83)} aria-label="تصغير"><ZoomOut size={17} /></button>
        <button onClick={fit} aria-label="ملاءمة الشجرة للشاشة"><Maximize2 size={16} /></button>
      </div>
    </div>
  );
}

function Sheet({ person, people, byId, onClose, onPick, onAdd, onEdit, onFocus, onRemove, onUnlink }) {
  const children = people.filter((p) => p.parentIds.includes(person.id));
  const sibs = people.filter(
    (p) => p.id !== person.id &&
      (p.siblingIds.includes(person.id) || p.parentIds.some((pid) => person.parentIds.includes(pid)))
  );
  return (
    <div className="fr-sheet-wrap" onClick={onClose}>
      <div className="fr-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="fr-grip" />
        <div className="fr-sheet-head">
          <Avatar p={person} size={52} />
          <div>
            <h3>{fullName(person)}</h3>
            <p>{years(person)}</p>
          </div>
          <button className="fr-ib" onClick={onClose} aria-label="إغلاق"><X size={19} /></button>
        </div>
        {person.notes && <p className="fr-notes">{person.notes}</p>}

        <Group label="الوالدان" list={person.parentIds.map((id) => byId[id]).filter(Boolean)} onPick={onPick}
          onUnlink={(o) => onUnlink("parent", o.id, person.id)} />
        <Group label="الزوج/الزوجة" list={person.spouseIds.map((id) => byId[id]).filter(Boolean)} onPick={onPick}
          onUnlink={(o) => onUnlink("spouse", person.id, o.id)} />
        <Group label="الأبناء" list={children} onPick={onPick}
          onUnlink={(o) => onUnlink("parent", person.id, o.id)} />
        <Group label="الإخوة" list={sibs} onPick={onPick}
          onUnlink={(o) => onUnlink("sibling", person.id, o.id)} />

        <div className="fr-add-row">
          <button onClick={() => onAdd("parent")}><Plus size={14} /> والد/والدة</button>
          <button onClick={() => onAdd("spouse")}><Plus size={14} /> زوج/زوجة</button>
          <button onClick={() => onAdd("child")}><Plus size={14} /> ابن/ابنة</button>
          <button onClick={() => onAdd("sibling")}><Plus size={14} /> أخ/أخت</button>
        </div>
        <div className="fr-add-row">
          <button onClick={onFocus}><Crosshair size={14} /> عرض هذا الفرع فقط</button>
          <button onClick={onEdit}><Pencil size={14} /> تعديل</button>
          <button className="danger" onClick={onRemove}><Trash2 size={14} /> حذف</button>
        </div>
      </div>
    </div>
  );
}

function Group({ label, list, onPick, onUnlink }) {
  if (!list.length) return null;
  return (
    <div className="fr-group">
      <div className="lb">{label}</div>
      {list.map((p) => (
        <span key={p.id} className="fr-chip">
          <span onClick={() => onPick(p.id)}>{fullName(p)}</span>
          <button onClick={() => onUnlink(p)} aria-label={`فك الربط مع ${fullName(p)}`}><X size={12} /></button>
        </span>
      ))}
    </div>
  );
}

const REL_LABEL = {
  parent: "هو أحد الوالدين لـ",
  child: "هو أحد الأبناء لـ",
  spouse: "متزوّج/ة من",
  sibling: "أخ أو أخت لـ",
};

function Dialog({ modal, people, onClose, onSave, onLink, say }) {
  const isEdit = modal.mode === "edit";
  const isLink = modal.mode === "link";
  const p = modal.person;

  const [f, setF] = useState({
    firstName: isEdit ? p.firstName : "",
    lastName: isEdit ? p.lastName : "",
    birthYear: isEdit ? p.birthYear : "",
    deathYear: isEdit ? p.deathYear : "",
    notes: isEdit ? p.notes : "",
    photo: isEdit ? p.photo : null,
  });
  const [relationType, setRelationType] = useState(modal.relationType === "root" ? "child" : modal.relationType || "child");
  const [relatedId, setRelatedId] = useState(modal.relatedId || people[0]?.id || "");
  const [secondParentId, setSecondParentId] = useState("");
  const [linkA, setLinkA] = useState(people[0]?.id || "");
  const [linkType, setLinkType] = useState("parent");
  const [linkB, setLinkB] = useState(people[1]?.id || "");
  const fileRef = useRef(null);

  const related = people.find((x) => x.id === relatedId);
  const spouseOptions = relationType === "child" && related
    ? related.spouseIds.map((id) => people.find((q) => q.id === id)).filter(Boolean) : [];

  useEffect(() => { setSecondParentId(""); }, [relatedId, relationType]);

  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function pickPhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try { const photo = await readPhoto(file); setF((s) => ({ ...s, photo })); }
    catch { say("تعذّرت قراءة هذه الصورة."); }
  }

  function submitPerson() {
    if (!f.firstName.trim()) { say("الاسم الأول مطلوب."); return; }
    onSave({
      editId: isEdit ? p.id : null,
      fields: {
        firstName: f.firstName.trim(), lastName: f.lastName.trim(),
        birthYear: f.birthYear.trim(), deathYear: f.deathYear.trim(),
        notes: f.notes.trim(), photo: f.photo,
      },
      relationType,
      relatedId: people.length ? relatedId : null,
      secondParentId,
    });
  }

  function submitLink() {
    const ok = linkType === "child" ? onLink("parent", linkB, linkA) : onLink(linkType, linkA, linkB);
    if (ok) onClose();
  }

  return (
    <div className="fr-modal-bg" onClick={onClose}>
      <div className="fr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fr-modal-head">
          <h3>{isLink ? "ربط شخصين" : isEdit ? "تعديل البيانات" : "إضافة فرد للعائلة"}</h3>
          <button className="fr-ib" onClick={onClose} aria-label="إغلاق"><X size={20} /></button>
        </div>

        {isLink ? (
          <>
            <div className="fr-field">
              <label>الشخص</label>
              <select value={linkA} onChange={(e) => setLinkA(e.target.value)}>
                {people.map((x) => <option key={x.id} value={x.id}>{fullName(x)}</option>)}
              </select>
            </div>
            <div className="fr-field">
              <label>نوع العلاقة</label>
              <select value={linkType} onChange={(e) => setLinkType(e.target.value)}>
                {Object.entries(REL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div className="fr-field">
              <label>الشخص</label>
              <select value={linkB} onChange={(e) => setLinkB(e.target.value)}>
                {people.map((x) => <option key={x.id} value={x.id}>{fullName(x)}</option>)}
              </select>
            </div>
            <div className="fr-modal-acts">
              <button className="fr-secondary" onClick={onClose}>إلغاء</button>
              <button className="fr-primary" onClick={submitLink}>حفظ الربط</button>
            </div>
          </>
        ) : (
          <>
            <div className="fr-photo-row">
              <Avatar p={f} size={62} />
              <div>
                <button className="fr-secondary sm" onClick={() => fileRef.current?.click()}>
                  <Camera size={14} /> {f.photo ? "تغيير الصورة" : "إضافة صورة"}
                </button>
                {f.photo && <button className="fr-linkbtn" onClick={() => setF((s) => ({ ...s, photo: null }))}>حذف الصورة</button>}
                <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickPhoto} />
              </div>
            </div>

            <div className="fr-row">
              <div className="fr-field"><label>الاسم الأول</label><input value={f.firstName} onChange={set("firstName")} autoFocus /></div>
              <div className="fr-field"><label>اللقب</label><input value={f.lastName} onChange={set("lastName")} /></div>
            </div>
            <div className="fr-row">
              <div className="fr-field"><label>الميلاد</label><input value={f.birthYear} onChange={set("birthYear")} placeholder="1958" inputMode="numeric" /></div>
              <div className="fr-field"><label>الوفاة</label><input value={f.deathYear} onChange={set("deathYear")} placeholder="اتركه فارغًا إذا كان على قيد الحياة" /></div>
            </div>
            <div className="fr-field"><label>ملاحظات</label><textarea value={f.notes} onChange={set("notes")} placeholder="أي شيء يستحق التذكّر" /></div>

            {!isEdit && people.length > 0 && (
              <div className="fr-relbox">
                <div className="fr-field">
                  <label>هذا الشخص</label>
                  <select value={relationType} onChange={(e) => setRelationType(e.target.value)}>
                    {Object.entries(REL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div className="fr-field">
                  <label>مع من؟</label>
                  <select value={relatedId} onChange={(e) => setRelatedId(e.target.value)}>
                    {people.map((x) => <option key={x.id} value={x.id}>{fullName(x)}</option>)}
                  </select>
                </div>
                {spouseOptions.length > 0 && (
                  <div className="fr-field">
                    <label>الوالد الثاني</label>
                    <select value={secondParentId} onChange={(e) => setSecondParentId(e.target.value)}>
                      <option value="">غير مسجَّل</option>
                      {spouseOptions.map((x) => <option key={x.id} value={x.id}>{fullName(x)}</option>)}
                    </select>
                  </div>
                )}
              </div>
            )}

            <div className="fr-modal-acts">
              <button className="fr-secondary" onClick={onClose}>إلغاء</button>
              <button className="fr-primary" onClick={submitPerson}>{isEdit ? "حفظ التعديلات" : "حفظ البيانات"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------- styles ---------------- */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Markazi+Text:wght@400;500;600;700&family=Tajawal:wght@400;500;700&display=swap');

.fr {
  --paper:#EFE7D6; --paper2:#E4DAC3; --card:#F8F3E7;
  --ink:#241C14; --soft:#6E6454; --rule:#C9BC9C;
  --green:#2F4A3C; --green2:#1D2E25; --gold:#A67C2E; --gold2:#C79A4B; --wine:#7A2E3B;
  font-family:'Tajawal',system-ui,sans-serif; background:var(--paper); color:var(--ink);
  position:absolute; inset:0; display:flex; flex-direction:column; overflow:hidden;
  -webkit-tap-highlight-color:transparent;
}
.fr *{box-sizing:border-box}
.fr button{font-family:inherit; cursor:pointer}
.fr-muted{color:var(--soft); font-size:14px}

.fr-head{background:var(--green2); color:var(--paper); border-bottom:3px solid var(--gold); flex-shrink:0}
.fr-head-in{display:flex; align-items:center; gap:12px; padding:12px 14px; max-width:1200px; margin:0 auto; width:100%}
.fr-title input{font-family:'Markazi Text',serif; font-size:25px; color:var(--paper);
  background:none; border:none; border-bottom:1px dashed rgba(239,231,214,.3); padding:0 2px 2px; width:100%; max-width:230px}
.fr-title input:focus{outline:none; border-bottom-color:var(--gold2)}
.fr-title p{margin:3px 0 0; font-size:12px; color:rgba(239,231,214,.6)}
.fr-head-tools{margin-inline-start:auto; display:flex; gap:2px}
.fr-ib{background:none; border:none; color:inherit; opacity:.85; padding:9px; border-radius:4px; display:flex}
.fr-ib:hover{opacity:1; background:rgba(255,255,255,.08)}
.fr-ib:disabled{opacity:.3}
.fr-back{background:none; border:1px solid rgba(239,231,214,.3); color:var(--paper); border-radius:4px;
  padding:8px 12px; font-size:13px; display:flex; align-items:center; gap:4px}
.fr-focus-note{margin:0; padding:0 14px 10px; font-size:12px; color:var(--gold2); font-family:'Markazi Text',serif}

.fr-main{flex:1; min-height:0; display:flex; position:relative}

.fr-canvas-wrap{flex:1; position:relative; overflow:hidden}
.fr-canvas{position:absolute; inset:0; touch-action:none; cursor:grab; overflow:hidden}
.fr-canvas:active{cursor:grabbing}
.fr-stage{position:absolute; transform-origin:0 0; will-change:transform}
.fr-edges{position:absolute; inset:0; pointer-events:none}
.e-child{fill:none; stroke:var(--rule); stroke-width:1.6}
.e-spouse{stroke:var(--gold); stroke-width:1.6}
.e-sib{fill:none; stroke:var(--rule); stroke-width:1.4; stroke-dasharray:4 3}

.fr-node{position:absolute; background:var(--card); border:1px solid var(--rule); border-radius:3px;
  display:flex; align-items:center; gap:9px; padding:0 10px; overflow:hidden}
.fr-node.on{border-color:var(--gold); box-shadow:0 0 0 2px rgba(166,124,46,.28)}
.fr-node-txt{min-width:0}
.fr-node .nm{font-family:'Markazi Text',serif; font-size:16px; font-weight:500; line-height:1.2;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.fr-node .yr{font-size:11px; color:var(--soft); margin-top:2px}

.fr-av{border-radius:50%; object-fit:cover; flex-shrink:0; border:1px solid var(--rule)}
.fr-av-ph{background:var(--green); color:var(--paper); display:flex; align-items:center; justify-content:center;
  font-family:'Markazi Text',serif; border-color:var(--green)}

.fr-zoom{position:absolute; inset-inline-end:12px; bottom:16px; display:flex; flex-direction:column;
  background:var(--card); border:1px solid var(--rule); border-radius:5px; overflow:hidden; z-index:15}
.fr-zoom button{background:none; border:none; padding:11px; color:var(--ink); display:flex}
.fr-zoom button+button{border-top:1px solid var(--paper2)}

.fr-blank{margin:auto; padding:40px 26px; max-width:340px; text-align:center}
.fr-blank h2{font-family:'Markazi Text',serif; font-weight:500; font-size:26px; margin:0 0 8px}
.fr-blank p{color:var(--soft); font-size:14px; line-height:1.6; margin:0 0 20px}
.fr-blank .fr-primary{max-width:220px; margin:0 auto}

.fr-list{flex:1; overflow-y:auto; padding:14px 14px 30px}
.fr-search{display:flex; align-items:center; gap:8px; background:var(--card); border:1px solid var(--rule);
  border-radius:4px; padding:11px 12px; margin-bottom:12px; color:var(--soft)}
.fr-search input{border:none; background:none; outline:none; font-family:inherit; font-size:16px; width:100%; color:var(--ink)}
.fr-list ul{list-style:none; margin:0; padding:0}
.fr-list li{display:flex; align-items:center; gap:12px; padding:11px 4px; border-bottom:1px solid var(--paper2)}
.fr-list .nm{font-family:'Markazi Text',serif; font-size:18px}
.fr-list .yr{font-size:12px; color:var(--soft); margin-top:1px}

.fr-connect{flex:1; overflow-y:auto; padding:22px 18px 40px; max-width:560px; margin:0 auto; width:100%}
.fr-connect h2{font-family:'Markazi Text',serif; font-weight:500; font-size:24px; margin:0 0 4px}
.fr-connect select{width:100%; font-family:inherit; font-size:16px; padding:13px 11px; margin-top:14px;
  border:1px solid var(--rule); border-radius:4px; background:var(--card); color:var(--ink)}
.fr-and{font-family:'Markazi Text',serif; color:var(--soft); text-align:center; margin-top:12px}
.fr-result{margin-top:22px; background:var(--card); border:1px solid var(--rule); border-inline-start:3px solid var(--gold);
  border-radius:4px; padding:18px}
.fr-result .rel{font-family:'Markazi Text',serif; font-size:21px; margin:0 0 10px; line-height:1.35}
.fr-result .rel b{font-weight:600}
.fr-result .path{font-size:12.5px; color:var(--soft); line-height:1.8; margin:0}

.fr-fab{position:absolute; inset-inline-end:16px; bottom:88px; width:56px; height:56px; border-radius:50%; border:none;
  background:var(--gold); color:var(--green2); display:flex; align-items:center; justify-content:center;
  box-shadow:0 4px 14px rgba(29,46,37,.3); z-index:20}

.fr-nav{display:flex; background:var(--card); border-bottom:1px solid var(--rule); flex-shrink:0; z-index:25}
.fr-nav button{flex:1; background:none; border:none; padding:10px 0 11px; color:var(--soft);
  display:flex; flex-direction:column; align-items:center; gap:3px; font-size:11px; border-bottom:2px solid transparent}
.fr-nav button.on{color:var(--green); font-weight:600; border-bottom-color:var(--gold)}

.fr-sheet-wrap{position:absolute; inset:0; background:rgba(29,46,37,.4); z-index:40; display:flex; align-items:flex-end}
.fr-sheet{background:var(--paper); width:100%; max-height:76vh; overflow-y:auto; border-radius:14px 14px 0 0;
  padding:8px 18px 26px; border-top:2px solid var(--gold)}
.fr-grip{width:38px; height:4px; background:var(--rule); border-radius:2px; margin:0 auto 12px}
.fr-sheet-head{display:flex; align-items:center; gap:12px}
.fr-sheet-head h3{font-family:'Markazi Text',serif; font-weight:500; font-size:22px; margin:0}
.fr-sheet-head p{margin:2px 0 0; font-size:12.5px; color:var(--soft)}
.fr-sheet-head .fr-ib{margin-inline-start:auto; color:var(--soft)}
.fr-notes{font-size:13.5px; line-height:1.6; margin:14px 0 4px}
.fr-group{margin-top:14px}
.fr-group .lb{font-size:11.5px; color:var(--soft); margin-bottom:6px}
.fr-chip{display:inline-flex; align-items:center; gap:2px; background:var(--paper2); border-radius:3px;
  font-family:'Markazi Text',serif; font-size:15px; padding-block:5px; padding-inline:10px 4px; margin-block-end:6px; margin-inline-end:6px}
.fr-chip>span{cursor:pointer}
.fr-chip button{background:none; border:none; color:var(--soft); padding:3px; display:flex; border-radius:2px}
.fr-chip button:hover{color:var(--wine)}
.fr-add-row{display:flex; flex-wrap:wrap; gap:6px; margin-top:12px}
.fr-add-row button{flex:1 1 auto; background:var(--card); border:1px solid var(--rule); border-radius:4px;
  padding:11px 10px; font-size:13px; display:flex; align-items:center; justify-content:center; gap:5px; color:var(--ink)}
.fr-add-row button.danger{color:var(--wine); border-color:rgba(122,46,59,.35)}

.fr-modal-bg{position:absolute; inset:0; background:rgba(29,46,37,.45); z-index:60; display:flex; align-items:flex-end}
.fr-modal{background:var(--paper); width:100%; max-height:92%; overflow-y:auto; border-radius:14px 14px 0 0;
  padding:16px 18px 24px; border-top:2px solid var(--gold)}
.fr-modal-head{display:flex; justify-content:space-between; align-items:center; margin-bottom:14px}
.fr-modal-head h3{font-family:'Markazi Text',serif; font-weight:500; font-size:21px; margin:0}
.fr-modal-head .fr-ib{color:var(--soft)}
.fr-photo-row{display:flex; align-items:center; gap:14px; margin-bottom:16px}
.fr-field{margin-bottom:12px; flex:1; min-width:0}
.fr-field label{display:block; font-size:11.5px; color:var(--soft); margin-bottom:5px}
.fr-field input,.fr-field select,.fr-field textarea{width:100%; font-family:inherit; font-size:16px;
  padding:11px; border:1px solid var(--rule); border-radius:4px; background:var(--card); color:var(--ink)}
.fr-field textarea{min-height:60px; resize:vertical}
.fr-row{display:flex; gap:10px}
.fr-relbox{background:var(--paper2); border-radius:5px; padding:12px 12px 2px; margin-top:6px}
.fr-modal-acts{display:flex; gap:8px; margin-top:16px}
.fr-primary{flex:1; background:var(--green); color:var(--paper); border:none; border-radius:4px;
  padding:14px; font-size:15px; font-weight:600; display:flex; align-items:center; justify-content:center; gap:6px}
.fr-secondary{flex:1; background:none; border:1px solid var(--rule); border-radius:4px; padding:14px;
  font-size:15px; color:var(--ink); display:flex; align-items:center; justify-content:center; gap:6px}
.fr-secondary.sm{padding:9px 12px; font-size:13px; flex:0 0 auto; display:inline-flex}
.fr-linkbtn{background:none; border:none; color:var(--soft); font-size:12px; text-decoration:underline; display:block; margin-top:8px; padding:0}

.fr-toast{position:absolute; left:50%; transform:translateX(-50%); bottom:24px; z-index:70;
  background:var(--green2); color:var(--paper); font-size:13.5px; padding:11px 16px; border-radius:6px;
  max-width:88%; box-shadow:0 4px 16px rgba(0,0,0,.25); text-align:center}

.fr-auth{align-items:center; justify-content:center; padding:24px}
.fr-auth-card{background:var(--card); border:1px solid var(--rule); border-top:3px solid var(--gold);
  border-radius:8px; padding:28px 24px; max-width:360px; width:100%; text-align:center}
.fr-auth-card h1{font-family:'Markazi Text',serif; font-weight:500; font-size:27px; margin:0 0 6px}
.fr-auth-tabs{display:flex; gap:4px; margin:18px 0 14px; background:var(--paper2); border-radius:6px; padding:3px}
.fr-auth-tabs button{flex:1; background:none; border:none; padding:9px 4px; font-size:12px; border-radius:4px; color:var(--soft)}
.fr-auth-tabs button.on{background:var(--card); color:var(--ink); font-weight:600; box-shadow:0 1px 3px rgba(0,0,0,.1)}
.fr-auth-card form{text-align:right}
.fr-auth-card .fr-primary{width:100%; margin-top:6px}
.fr-auth-error{color:var(--wine); font-size:12.5px; margin:-4px 0 12px}

@media (min-width:820px){
  .fr-nav{justify-content:center; gap:8px; padding:2px}
  .fr-nav button{flex:0 0 auto; flex-direction:row; padding:12px 20px; font-size:13.5px; gap:7px}
  .fr-sheet-wrap{align-items:stretch; justify-content:flex-end; background:none; pointer-events:none}
  .fr-sheet{pointer-events:auto; width:330px; max-height:none; border-radius:0; border-top:none;
    border-inline-start:1px solid var(--rule); padding:20px 20px 30px; box-shadow:-6px 0 20px rgba(29,46,37,.12)}
  .fr-grip{display:none}
  .fr-modal-bg{align-items:center; justify-content:center; padding:24px}
  .fr-modal{max-width:440px; border-radius:6px; border:1px solid var(--rule); border-top:2px solid var(--gold)}
  .fr-fab{bottom:24px; inset-inline-end:auto; inset-inline-start:24px}
  .fr-zoom{bottom:24px; inset-inline-end:16px}
}
`;
