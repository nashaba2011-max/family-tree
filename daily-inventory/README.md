# المخزون اليومي (Daily Inventory)

A standalone app for tracking daily stock across multiple branches. Before
recording an order for a branch, you enter how much of each item is
currently on hand. React + Vite, no backend — everything is stored in the
browser on your device, independent from the Family Register app in this
repository.

## Run it locally

```bash
cd daily-inventory
npm install
npm run dev
```

Opens at http://localhost:5173 (or the next free port if the family-tree
app is already running there).

## Deploy to Vercel

Same steps as the Family Register app — import the repository on
vercel.com/new, but set the project's **Root Directory** to
`daily-inventory` so Vercel builds this app instead of the one at the repo
root.

## How it works

- **الفروع (Branches)** and **الأصناف (Items)** are managed from
  الإعدادات — add your branches once and the shared item list you count in
  each of them.
- **طلب اليوم (Today's order)** is the daily form: pick a branch and a
  date, then enter the quantity on hand and the quantity to order for each
  item. Saving records both the stock count and the order together.
- **السجل (History)** lists every saved day, per branch, with the full
  breakdown and a way to delete a record.

## Where the data lives

Saved to `localStorage` under the key `dailyInventory:v1`, on the device
and browser you used. Use **Save a copy** (download icon) to export a JSON
backup of branches, items, and every recorded day, and **Load a copy** to
restore it or move it to another device.
