import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import {
  Plus, X, Trash2, Pencil, Package, ClipboardList, History as HistoryIcon,
  Settings2, Download, Upload, Copy,
} from "lucide-react";

const STORE_KEY = "dailyInventory:v1";

/* Browser storage. Kept behind a tiny async wrapper so the app code
   doesn't care where the data actually lives. */
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
      const probe = "__dailyInventory_probe__";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  },
};

/* ---------------- data helpers ---------------- */

const makeId = () => "i" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function normalizeBranch(b) {
  return { id: b.id || makeId(), name: b.name || "" };
}
function normalizeItem(it) {
  return { id: it.id || makeId(), name: it.name || "", unit: it.unit || "" };
}
function normalizeRecord(r) {
  return {
    id: r.id || makeId(),
    branchId: r.branchId || "",
    date: r.date || todayStr(),
    note: r.note || "",
    entries: r.entries && typeof r.entries === "object" ? r.entries : {},
    updatedAt: r.updatedAt || new Date().toISOString(),
  };
}

function countPhrase(n, singular, dual, plural) {
  if (n === 0) return `لا يوجد ${plural}`;
  if (n === 1) return `${singular} واحد`;
  if (n === 2) return dual;
  if (n >= 3 && n <= 10) return `${n} ${plural}`;
  return `${n} ${singular}`;
}

const toNum = (v) => {
  const n = Number(v);
  return v !== "" && Number.isFinite(n) ? n : 0;
};

/* ---------------- app ---------------- */

export default function App() {
  const [branches, setBranches] = useState([]);
  const [items, setItems] = useState([]);
  const [records, setRecords] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("order");
  const [branchId, setBranchId] = useState(null);
  const [date, setDate] = useState(todayStr());
  const [toast, setToast] = useState(null);
  const importRef = useRef(null);

  const say = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => {
    (async () => {
      if (!store.isAvailable()) {
        say("التصفح الخاص أو إعداد يحظر تخزين بيانات الموقع يعني أن التعديلات لن تُحفظ.");
      }
      try {
        const r = await store.get(STORE_KEY);
        if (r?.value) {
          const d = JSON.parse(r.value);
          if (Array.isArray(d.branches)) setBranches(d.branches.map(normalizeBranch));
          if (Array.isArray(d.items)) setItems(d.items.map(normalizeItem));
          if (Array.isArray(d.records)) setRecords(d.records.map(normalizeRecord));
        }
      } catch { /* nothing saved yet */ }
      setLoaded(true);
    })();
  }, [say]);

  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      store.set(STORE_KEY, JSON.stringify({ branches, items, records }))
        .catch((e) => say(
          e?.name === "QuotaExceededError"
            ? "تعذّر الحفظ — البيانات كبيرة جدًا على تخزين المتصفح."
            : "تعذّر الحفظ — قد يكون السبب التصفح الخاص أو حظر التخزين."
        ));
    }, 400);
    return () => clearTimeout(t);
  }, [branches, items, records, loaded, say]);

  useEffect(() => {
    if (!branchId && branches.length) setBranchId(branches[0].id);
    if (branchId && !branches.some((b) => b.id === branchId)) setBranchId(branches[0]?.id || null);
  }, [branches, branchId]);

  function addBranch(name) {
    const n = name.trim();
    if (!n) return;
    setBranches((prev) => [...prev, { id: makeId(), name: n }]);
  }
  function renameBranch(id, name) {
    setBranches((prev) => prev.map((b) => (b.id === id ? { ...b, name } : b)));
  }
  function deleteBranch(id) {
    setBranches((prev) => prev.filter((b) => b.id !== id));
    setRecords((prev) => prev.filter((r) => r.branchId !== id));
  }

  function addItem(name, unit) {
    const n = name.trim();
    if (!n) return;
    setItems((prev) => [...prev, { id: makeId(), name: n, unit: unit.trim() }]);
  }
  function updateItem(id, fields) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...fields } : it)));
  }
  function deleteItem(id) {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }

  function saveRecord(bId, d, entries, note) {
    setRecords((prev) => {
      const existing = prev.find((r) => r.branchId === bId && r.date === d);
      const next = { id: existing?.id || makeId(), branchId: bId, date: d, entries, note, updatedAt: new Date().toISOString() };
      return existing ? prev.map((r) => (r.id === existing.id ? next : r)) : [...prev, next];
    });
    say("تم حفظ الجرد والطلب لهذا اليوم.");
  }
  function deleteRecord(id) {
    setRecords((prev) => prev.filter((r) => r.id !== id));
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ branches, items, records, exportedAt: new Date().toISOString() }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `daily-inventory-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importJson(file) {
    try {
      const d = JSON.parse(await file.text());
      if (!Array.isArray(d.branches) || !Array.isArray(d.items) || !Array.isArray(d.records)) throw new Error("shape");
      setBranches(d.branches.map(normalizeBranch));
      setItems(d.items.map(normalizeItem));
      setRecords(d.records.map(normalizeRecord));
      say(`تم تحميل ${countPhrase(d.records.length, "سجل", "سجلّان", "سجلات")}.`);
    } catch {
      say("هذا الملف ليس نسخة مُصدَّرة من بيانات المخزون.");
    }
  }

  const currentBranch = branches.find((b) => b.id === branchId) || null;
  const existingRecord = useMemo(
    () => records.find((r) => r.branchId === branchId && r.date === date) || null,
    [records, branchId, date]
  );
  const previousRecord = useMemo(() => {
    if (!branchId) return null;
    const list = records.filter((r) => r.branchId === branchId && r.date !== date).sort((a, b) => b.date.localeCompare(a.date));
    return list[0] || null;
  }, [records, branchId, date]);

  if (!loaded) return null;

  return (
    <div className="di" dir="rtl" lang="ar">
      <style>{CSS}</style>

      <header className="di-head">
        <div className="di-head-in">
          <div className="di-title">
            <Package size={22} />
            <div>
              <h1>المخزون اليومي</h1>
              <p>{countPhrase(branches.length, "فرع", "فرعان", "فروع")} • {countPhrase(items.length, "صنف", "صنفان", "أصناف")}</p>
            </div>
          </div>
          <div className="di-head-tools">
            <button className="di-ib" title="حفظ نسخة" onClick={exportJson}><Download size={17} /></button>
            <button className="di-ib" title="تحميل نسخة محفوظة" onClick={() => importRef.current?.click()}><Upload size={17} /></button>
            <input ref={importRef} type="file" accept="application/json" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ""; }} />
          </div>
        </div>
      </header>

      <nav className="di-nav">
        <button className={view === "order" ? "on" : ""} onClick={() => setView("order")}><ClipboardList size={19} /><span>طلب اليوم</span></button>
        <button className={view === "history" ? "on" : ""} onClick={() => setView("history")}><HistoryIcon size={19} /><span>السجل</span></button>
        <button className={view === "settings" ? "on" : ""} onClick={() => setView("settings")}><Settings2 size={19} /><span>الإعدادات</span></button>
      </nav>

      <main className="di-main">
        {view === "order" && (
          <OrderView
            branches={branches} items={items} branchId={branchId} setBranchId={setBranchId}
            date={date} setDate={setDate} currentBranch={currentBranch}
            existingRecord={existingRecord} previousRecord={previousRecord}
            onSave={(entries, note) => saveRecord(branchId, date, entries, note)}
            goSettings={() => setView("settings")}
          />
        )}
        {view === "history" && (
          <HistoryView branches={branches} records={records} onDelete={deleteRecord} />
        )}
        {view === "settings" && (
          <SettingsView
            branches={branches} items={items}
            onAddBranch={addBranch} onRenameBranch={renameBranch} onDeleteBranch={deleteBranch}
            onAddItem={addItem} onUpdateItem={updateItem} onDeleteItem={deleteItem}
          />
        )}
      </main>

      {toast && <div className="di-toast">{toast}</div>}
    </div>
  );
}

/* ---------------- order view ---------------- */

function OrderView({ branches, items, branchId, setBranchId, date, setDate, currentBranch, existingRecord, previousRecord, onSave, goSettings }) {
  if (branches.length === 0) {
    return (
      <div className="di-blank">
        <h2>أضف فروعك أولًا</h2>
        <p>لديك 9 فروع؟ أضفها من الإعدادات لتبدأ بتسجيل جردها اليومي.</p>
        <button className="di-primary" onClick={goSettings}><Plus size={16} /> إضافة الفروع</button>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="di-blank">
        <h2>أضف الأصناف أولًا</h2>
        <p>أضف قائمة الأصناف التي يتم جردها في كل فرع من الإعدادات.</p>
        <button className="di-primary" onClick={goSettings}><Plus size={16} /> إضافة الأصناف</button>
      </div>
    );
  }
  return (
    <div className="di-order">
      <div className="di-chips">
        {branches.map((b) => (
          <button key={b.id} className={"di-chip" + (b.id === branchId ? " on" : "")} onClick={() => setBranchId(b.id)}>{b.name}</button>
        ))}
      </div>
      <div className="di-field di-date">
        <label>التاريخ</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      {currentBranch && (
        <OrderForm
          key={`${branchId}|${date}`}
          items={items}
          existingRecord={existingRecord}
          previousRecord={previousRecord}
          onSave={onSave}
        />
      )}
    </div>
  );
}

function OrderForm({ items, existingRecord, previousRecord, onSave }) {
  const [entries, setEntries] = useState(() => {
    const map = {};
    items.forEach((it) => {
      const ex = existingRecord?.entries?.[it.id];
      map[it.id] = { onHand: ex ? String(ex.onHand) : "", order: ex ? String(ex.order) : "" };
    });
    return map;
  });
  const [note, setNote] = useState(existingRecord?.note || "");

  const setField = (id, field, value) => {
    if (value !== "" && !/^\d*\.?\d*$/.test(value)) return;
    setEntries((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  };

  function copyFromPrevious() {
    if (!previousRecord) return;
    setEntries((prev) => {
      const next = { ...prev };
      items.forEach((it) => {
        const pe = previousRecord.entries[it.id];
        if (pe) next[it.id] = { ...next[it.id], onHand: String(pe.onHand) };
      });
      return next;
    });
  }

  function submit() {
    const out = {};
    items.forEach((it) => {
      const e = entries[it.id] || {};
      out[it.id] = { name: it.name, unit: it.unit, onHand: toNum(e.onHand), order: toNum(e.order) };
    });
    onSave(out, note.trim());
  }

  return (
    <div className="di-form">
      {previousRecord && (
        <div className="di-hint">
          <span>آخر جرد لهذا الفرع بتاريخ {previousRecord.date}.</span>
          <button onClick={copyFromPrevious}><Copy size={13} /> نسخ الكميات الموجودة</button>
        </div>
      )}
      <div className="di-table">
        <div className="di-row di-row-h">
          <span className="nm">الصنف</span>
          <span>الكمية الموجودة</span>
          <span>الكمية المطلوبة</span>
        </div>
        {items.map((it) => (
          <div className="di-row" key={it.id}>
            <span className="nm">{it.name}{it.unit ? <em> ({it.unit})</em> : null}</span>
            <input inputMode="decimal" placeholder="0" value={entries[it.id]?.onHand ?? ""} onChange={(e) => setField(it.id, "onHand", e.target.value)} />
            <input inputMode="decimal" placeholder="0" value={entries[it.id]?.order ?? ""} onChange={(e) => setField(it.id, "order", e.target.value)} />
          </div>
        ))}
      </div>
      <div className="di-field">
        <label>ملاحظات (اختياري)</label>
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <button className="di-primary di-save" onClick={submit}>{existingRecord ? "تحديث جرد اليوم" : "حفظ جرد اليوم"}</button>
    </div>
  );
}

/* ---------------- history view ---------------- */

function HistoryView({ branches, records, onDelete }) {
  const [filterBranch, setFilterBranch] = useState("all");
  const [openId, setOpenId] = useState(null);
  const byBranch = useMemo(() => Object.fromEntries(branches.map((b) => [b.id, b])), [branches]);

  const filtered = useMemo(
    () => records
      .filter((r) => filterBranch === "all" || r.branchId === filterBranch)
      .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)),
    [records, filterBranch]
  );
  const open = records.find((r) => r.id === openId) || null;

  return (
    <div className="di-history">
      <div className="di-chips">
        <button className={"di-chip" + (filterBranch === "all" ? " on" : "")} onClick={() => setFilterBranch("all")}>الكل</button>
        {branches.map((b) => (
          <button key={b.id} className={"di-chip" + (filterBranch === b.id ? " on" : "")} onClick={() => setFilterBranch(b.id)}>{b.name}</button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <p className="di-muted">لا توجد سجلات بعد.</p>
      ) : (
        <ul className="di-hist-list">
          {filtered.map((r) => {
            const vals = Object.values(r.entries || {});
            const totalOrder = vals.reduce((s, v) => s + (v.order || 0), 0);
            return (
              <li key={r.id} onClick={() => setOpenId(r.id)}>
                <div>
                  <div className="dt">{r.date}</div>
                  <div className="br">{byBranch[r.branchId]?.name || "فرع محذوف"}</div>
                </div>
                <div className="sum">{totalOrder > 0 ? `طلب: ${totalOrder}` : "لا يوجد طلب"}</div>
              </li>
            );
          })}
        </ul>
      )}

      {open && (
        <div className="di-sheet-wrap" onClick={() => setOpenId(null)}>
          <div className="di-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="di-grip" />
            <div className="di-sheet-head">
              <div>
                <h3>{byBranch[open.branchId]?.name || "فرع محذوف"}</h3>
                <p>{open.date}</p>
              </div>
              <button className="di-ib" onClick={() => setOpenId(null)} aria-label="إغلاق"><X size={19} /></button>
            </div>
            <div className="di-table">
              <div className="di-row di-row-h">
                <span className="nm">الصنف</span>
                <span>الموجود</span>
                <span>المطلوب</span>
              </div>
              {Object.entries(open.entries || {}).map(([id, e]) => (
                <div className="di-row" key={id}>
                  <span className="nm">{e.name}{e.unit ? <em> ({e.unit})</em> : null}</span>
                  <span>{e.onHand}</span>
                  <span>{e.order}</span>
                </div>
              ))}
            </div>
            {open.note && <p className="di-notes">{open.note}</p>}
            <button className="di-danger" onClick={() => { onDelete(open.id); setOpenId(null); }}><Trash2 size={14} /> حذف هذا السجل</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- settings view ---------------- */

function SettingsView({ branches, items, onAddBranch, onRenameBranch, onDeleteBranch, onAddItem, onUpdateItem, onDeleteItem }) {
  const [newBranch, setNewBranch] = useState("");
  const [newItemName, setNewItemName] = useState("");
  const [newItemUnit, setNewItemUnit] = useState("");

  return (
    <div className="di-settings">
      <section className="di-card">
        <h2>الفروع</h2>
        {branches.length === 0 && <p className="di-muted">لم تُضف أي فروع بعد.</p>}
        {branches.map((b) => (
          <div className="di-edit-row" key={b.id}>
            <Pencil size={14} className="di-ic" />
            <input defaultValue={b.name} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== b.name) onRenameBranch(b.id, v); else e.target.value = b.name; }} />
            <button className="di-ib" onClick={() => onDeleteBranch(b.id)} aria-label={`حذف ${b.name}`}><X size={16} /></button>
          </div>
        ))}
        <div className="di-add-row">
          <input placeholder="اسم الفرع الجديد" value={newBranch} onChange={(e) => setNewBranch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && newBranch.trim()) { onAddBranch(newBranch); setNewBranch(""); } }} />
          <button className="di-primary" onClick={() => { if (newBranch.trim()) { onAddBranch(newBranch); setNewBranch(""); } }}><Plus size={15} /> إضافة</button>
        </div>
      </section>

      <section className="di-card">
        <h2>الأصناف</h2>
        {items.length === 0 && <p className="di-muted">لم تُضف أي أصناف بعد.</p>}
        {items.map((it) => (
          <div className="di-edit-row" key={it.id}>
            <Pencil size={14} className="di-ic" />
            <input defaultValue={it.name} placeholder="اسم الصنف"
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== it.name) onUpdateItem(it.id, { name: v }); else e.target.value = it.name; }} />
            <input className="di-unit" defaultValue={it.unit} placeholder="الوحدة"
              onBlur={(e) => { const v = e.target.value.trim(); if (v !== it.unit) onUpdateItem(it.id, { unit: v }); }} />
            <button className="di-ib" onClick={() => onDeleteItem(it.id)} aria-label={`حذف ${it.name}`}><X size={16} /></button>
          </div>
        ))}
        <div className="di-add-row">
          <input placeholder="اسم الصنف الجديد" value={newItemName} onChange={(e) => setNewItemName(e.target.value)} />
          <input className="di-unit" placeholder="الوحدة (مثال: كرتون)" value={newItemUnit} onChange={(e) => setNewItemUnit(e.target.value)} />
          <button className="di-primary" onClick={() => { if (newItemName.trim()) { onAddItem(newItemName, newItemUnit); setNewItemName(""); setNewItemUnit(""); } }}><Plus size={15} /> إضافة</button>
        </div>
      </section>
    </div>
  );
}

/* ---------------- styles ---------------- */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Markazi+Text:wght@400;500;600;700&family=Tajawal:wght@400;500;700&display=swap');
.di{
  --paper:#F2EFE6; --card:#FFFFFF;
  --ink:#1D2430; --soft:#6B7280; --rule:#DAD6C9;
  --navy:#1F3A52; --navy2:#16293B; --amber:#D8973C; --amber2:#E4AF63;
  --green:#2F6B4F; --red:#B3261E;
  font-family:'Tajawal',system-ui,sans-serif; background:var(--paper); color:var(--ink);
  height:100%; display:flex; flex-direction:column; overflow:hidden;
  -webkit-tap-highlight-color:transparent;
}
.di *{box-sizing:border-box}
.di button{font-family:inherit; cursor:pointer}
.di-muted{color:var(--soft); font-size:14px}

.di-head{background:var(--navy); color:var(--paper); border-bottom:3px solid var(--amber); flex-shrink:0}
.di-head-in{display:flex; align-items:center; justify-content:space-between; padding:14px 16px; gap:10px}
.di-title{display:flex; align-items:center; gap:10px}
.di-title h1{font-family:'Markazi Text',serif; font-size:23px; font-weight:600; margin:0}
.di-title p{margin:2px 0 0; font-size:12px; color:rgba(242,239,230,.7)}
.di-head-tools{display:flex; gap:2px}
.di-ib{background:none; border:none; color:inherit; opacity:.85; padding:9px; border-radius:4px; display:flex}
.di-ib:hover{opacity:1; background:rgba(255,255,255,.08)}

.di-nav{display:flex; background:var(--card); border-bottom:1px solid var(--rule); flex-shrink:0; z-index:5}
.di-nav button{flex:1; background:none; border:none; padding:10px 0 11px; color:var(--soft);
  display:flex; flex-direction:column; align-items:center; gap:3px; font-size:11.5px; border-bottom:2px solid transparent}
.di-nav button.on{color:var(--navy); font-weight:600; border-bottom-color:var(--amber)}

.di-main{flex:1; overflow-y:auto; padding:14px 16px 28px}

.di-chips{display:flex; flex-wrap:wrap; gap:7px; margin-bottom:12px}
.di-chip{background:var(--card); border:1px solid var(--rule); border-radius:20px; padding:7px 14px; font-size:13.5px; color:var(--ink)}
.di-chip.on{background:var(--navy); border-color:var(--navy); color:var(--paper)}

.di-field{margin-bottom:14px}
.di-field label{display:block; font-size:11.5px; color:var(--soft); margin-bottom:5px}
.di-field input, .di-field textarea{width:100%; font-family:inherit; font-size:16px; padding:10px 11px;
  border:1px solid var(--rule); border-radius:6px; background:var(--card); color:var(--ink)}
.di-date input{max-width:200px}

.di-blank{text-align:center; padding:48px 12px}
.di-blank h2{font-family:'Markazi Text',serif; font-weight:600; font-size:24px; margin:0 0 8px}
.di-blank p{color:var(--soft); font-size:14px; line-height:1.6; margin:0 0 20px}

.di-primary{background:var(--green); color:#fff; border:none; border-radius:6px; padding:11px 18px;
  font-size:14px; font-weight:600; display:inline-flex; align-items:center; gap:6px}
.di-danger{background:none; border:1px solid rgba(179,38,30,.4); color:var(--red); border-radius:6px;
  padding:10px 14px; font-size:13px; display:inline-flex; align-items:center; gap:6px; margin-top:14px}

.di-hint{display:flex; align-items:center; justify-content:space-between; gap:10px; background:var(--card);
  border:1px solid var(--rule); border-inline-start:3px solid var(--amber); border-radius:6px;
  padding:10px 12px; font-size:12.5px; color:var(--soft); margin-bottom:14px}
.di-hint button{background:none; border:1px solid var(--rule); border-radius:5px; padding:6px 10px;
  font-size:12px; color:var(--ink); display:flex; align-items:center; gap:5px; white-space:nowrap}

.di-table{background:var(--card); border:1px solid var(--rule); border-radius:8px; overflow:hidden; margin-bottom:14px}
.di-row{display:grid; grid-template-columns:1fr 90px 90px; gap:8px; align-items:center; padding:10px 12px; border-bottom:1px solid var(--rule)}
.di-row:last-child{border-bottom:none}
.di-row-h{background:var(--paper); font-size:11.5px; color:var(--soft)}
.di-row .nm{font-size:14.5px}
.di-row .nm em{color:var(--soft); font-style:normal; font-size:12px}
.di-row input{width:100%; font-family:inherit; font-size:15px; padding:7px 8px; text-align:center;
  border:1px solid var(--rule); border-radius:5px; background:var(--paper)}

.di-save{width:100%; justify-content:center}

.di-hist-list{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px}
.di-hist-list li{display:flex; align-items:center; justify-content:space-between; background:var(--card);
  border:1px solid var(--rule); border-radius:8px; padding:12px 14px}
.di-hist-list .dt{font-family:'Markazi Text',serif; font-size:17px}
.di-hist-list .br{font-size:12px; color:var(--soft); margin-top:1px}
.di-hist-list .sum{font-size:13px; color:var(--navy); font-weight:600}

.di-sheet-wrap{position:fixed; inset:0; background:rgba(22,41,59,.45); z-index:40; display:flex; align-items:flex-end}
.di-sheet{background:var(--paper); width:100%; max-height:82vh; overflow-y:auto; border-radius:14px 14px 0 0;
  padding:10px 16px 24px; margin:0 auto; max-width:560px}
.di-grip{width:38px; height:4px; background:var(--rule); border-radius:2px; margin:0 auto 12px}
.di-sheet-head{display:flex; align-items:flex-start; gap:10px; margin-bottom:14px}
.di-sheet-head h3{font-family:'Markazi Text',serif; font-weight:600; font-size:20px; margin:0}
.di-sheet-head p{margin:2px 0 0; font-size:12.5px; color:var(--soft)}
.di-sheet-head .di-ib{margin-inline-start:auto; color:var(--soft)}
.di-notes{font-size:13px; color:var(--soft); background:var(--card); border:1px solid var(--rule); border-radius:6px; padding:9px 11px}

.di-card{background:var(--card); border:1px solid var(--rule); border-radius:8px; padding:16px; margin-bottom:16px}
.di-card h2{font-family:'Markazi Text',serif; font-weight:600; font-size:19px; margin:0 0 12px}
.di-edit-row{display:flex; align-items:center; gap:8px; margin-bottom:8px}
.di-ic{color:var(--soft); flex-shrink:0}
.di-edit-row input{flex:1; font-family:inherit; font-size:14.5px; padding:8px 10px; border:1px solid var(--rule);
  border-radius:5px; background:var(--paper); color:var(--ink)}
.di-edit-row .di-unit{flex:0 0 110px}
.di-add-row{display:flex; gap:8px; margin-top:10px}
.di-add-row input{flex:1; font-family:inherit; font-size:14.5px; padding:9px 10px; border:1px solid var(--rule);
  border-radius:5px; background:var(--paper); color:var(--ink)}
.di-add-row .di-unit{flex:0 0 130px}
.di-add-row .di-primary{flex-shrink:0}

.di-toast{position:fixed; bottom:18px; left:50%; transform:translateX(-50%); background:var(--navy2); color:var(--paper);
  padding:11px 18px; border-radius:8px; font-size:13.5px; max-width:88%; text-align:center; z-index:80;
  box-shadow:0 6px 18px rgba(0,0,0,.25)}

@media (min-width:640px){
  .di-main{max-width:640px; margin:0 auto; width:100%}
  .di-sheet{border-radius:14px; margin-bottom:24px}
}
`;
