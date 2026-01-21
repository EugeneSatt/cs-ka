# CS Vert

Minimal online FPS prototype with server authoritative movement, hitscan combat, elimination rounds, and JSON maps.

## Quick start

1) Start the server:

```
cd server
npm install
npm run dev
```

2) Start the client:

```
cd client
npm install
npm run dev
```

3) Open `http://localhost:5173` in two or more browser tabs. Up to six players can join.

## Controls

- Move: `WASD`
- Jump: `Space`
- Shoot: `Left Mouse`
- Switch weapons: `1` (primary), `2` (pistol), `3` (grenade)
- Reload: `R`
- Throw grenade: `G`

## Map format (JSON)

Maps live in `shared/maps`. The server loads the JSON and sends it to clients on connect.

Example:

```json
{
  "name": "Arena",
  "boxes": [
    { "min": [-20, -1, -20], "max": [20, 0, 20], "color": "#2e2e2e" }
  ],
  "spawns": {
    "T": [[-14, 0.1, -14], [-12, 0.1, -14], [-14, 0.1, -12]],
    "CT": [[14, 0.1, 14], [12, 0.1, 14], [14, 0.1, 12]]
  }
}
```

- `boxes`: axis-aligned solids used for collision and rendering. `min` and `max` are corners in world space.
- `spawns`: arrays of spawn points for each side. Y should be slightly above the floor.

To use a new map, drop a JSON file in `shared/maps` and start the server with:

```
MAP=my-map.json npm run dev
```

## Notes

- Match rules: 8 rounds, 10s freeze time, 115s round time, 3v3, sides swap after round 4.
- Server runs on `ws://localhost:8080` by default. Set `PORT` to change it.
