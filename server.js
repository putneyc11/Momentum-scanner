/* Premarket Momentum Scanner — local server + Alpaca proxy
   Requires Node 18+ (built-in fetch). No npm install needed.
   Run:   node server.js
   Open:  http://localhost:8787
*/
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8787;
const ROUTES = {
  "/alpaca": "https://data.alpaca.markets",     // market data
  "/trading": "https://paper-api.alpaca.markets", // asset/listing lookups
};

const server = http.createServer(async (req, res) => {
  const prefix = Object.keys(ROUTES).find((p) => req.url.startsWith(p + "/"));
  if (prefix) {
    const target = ROUTES[prefix] + req.url.slice(prefix.length);
    try {
      const r = await fetch(target, {
        headers: {
          "APCA-API-KEY-ID": req.headers["apca-api-key-id"] || "",
          "APCA-API-SECRET-KEY": req.headers["apca-api-secret-key"] || "",
        },
      });
      const body = await r.text();
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(body);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end("index.html not found — keep it next to server.js");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Momentum scanner running → http://localhost:${PORT}\n`);
});
