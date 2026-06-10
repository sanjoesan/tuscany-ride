# Tuscany Ride 🚴🌄

A **free** 3D indoor cycling game for your smart trainer. No subscription, no
other riders - just you, your bike and the Tuscan hills.

- Connects to any **FTMS smart trainer** over Bluetooth (Wahoo, Tacx, Elite,
  Saris, JetBlack, ...) - power, cadence, and the trainer's resistance follows
  the slope of the road. Power meters (Cycling Power Service) and heart-rate
  straps work too.
- A procedural **Tuscany**: rolling farmland with vineyards, olive groves,
  wheat fields, cypress alleys, a small Italian town with a campanile, and
  the sea on the coast. Realistic lighting, shadows and water.
- **Garmin Connect export**: every ride is recorded and saved as a standard
  `.FIT` file with GPS mapped to the real Tuscan coast - upload it and Garmin
  shows your ride on the map, with power, HR, speed and elevation.
- A built-in **world builder**: reshape the road, place buildings and trees,
  move the town, change the terrain - and save/load maps as JSON.

## Play

**Online:** https://sanjoesan.github.io/tuscany-ride/ - open it in **Chrome or
Edge** (Web Bluetooth). Every push to `main` deploys automatically via GitHub
Actions.

**Local development:**

```powershell
npm install
npm run dev        # then open http://localhost:5173 in Chrome or Edge
```

No trainer at hand? Click **Demo Mode** and ride with the arrow keys
(up/down = power).

## Upload to Garmin Connect

After a ride, click **Download .FIT** on the summary screen, then either:

- **Manual:** connect.garmin.com → cloud icon ⊕ → *Import Data* → drop the file.
- **Automatic:** `npm run upload` - uploads the newest `.fit` from your
  Downloads folder. Credentials via environment variables `GARMIN_EMAIL` /
  `GARMIN_PASSWORD`, or a `.garmin.json` file next to `package.json`:
  `{ "email": "you@example.com", "password": "..." }` (stays on your machine;
  this uses the unofficial garmin-connect library).

## Controls

| Key / UI | Action |
| --- | --- |
| C | camera: chase / front / side |
| ↑ ↓ | demo mode: power +/- |
| ← → | demo mode: cadence |
| Trainer difficulty slider | how much of the slope reaches the trainer |
| World Builder | edit the map (tools: select / road / place / town) |

## Tests

```powershell
npx tsx tools/smoketest.ts   # terrain, road, physics, FIT encoder
```
