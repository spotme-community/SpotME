# 🗺️ SpotMe · Caching

> **Entdecke. Verbinde. Triff dich.**  
> Eine mobile-first PWA zum Setzen, Teilen und Entdecken von geheimen Spots — mit integriertem Einladungssystem, Profilen, Chat und Navigation.

---

## 📖 Über das Projekt

SpotMe Caching ist ein Open-Source-Geocaching-Konzept das über klassisches Geocaching hinausgeht. Es verbindet standortbasiertes Entdecken mit einem sozialen Layer — Nutzer setzen Spots, hinterlassen Fotos und Beschreibungen, laden andere ein und kommunizieren direkt über den integrierten Messenger.

Das Projekt läuft als Progressive Web App (PWA) direkt im Browser — keine App-Installation nötig.

---

## ✨ Features

### 🗺️ Karte
- **MapLibre GL** mit OpenFreeMap Tiles — 100% Open Source, kein API-Key
- Eigene Spot-Marker (Amber) mit Online-Puls-Indikator
- Fremde Spot-Marker mit Live-Online-Status
- Radius-Suche (2 / 5 / 10 km) mit GeoJSON-Kreis auf der Karte
- **Neue Spots** — zeigt Spots der letzten 24h im 2km Umkreis mit grünem Puls-Marker
- Doppelte Navigation: 🚶 Fußweg (Cyan) + 🚗 Auto (Amber) via OSRM — Open Source Routing

### 📍 Spots
- Spot setzen durch Tap auf die Karte
- Name, Beschreibung, Wunsch-Tag und optionales Foto pro Spot
- Spot bearbeiten und löschen
- Spot-Alter-Anzeige (gerade eben / vor X Min / vor Xh / gestern)
- Foto-Fullscreen per Tap
- Bild-Moderation: jedes neue Spot-Foto muss vom Admin freigegeben werden

### 👤 Profile
- Anzeigename, Geburtsjahr (einmalig), Region/Provinz/Stadt
- Bio, Wünsche und Angebote als Chip-Tags
- Avatar-Upload mit automatischer Komprimierung (Canvas, JPEG 72%)
- Avatar-Moderation durch Admin
- Meine Spots Tab — alle eigenen Spots in der Profilansicht
- Export als JSON

### 📨 Einladungssystem
- Einladung an Spot-Inhaber senden (Zeitraum wählen)
- Akzeptieren / Ablehnen
- Check-in per GPS wenn beide am Spot sind
- Match-Screen bei gegenseitigem Check-in

### 💬 Chat
- Direktnachrichten zwischen Nutzer und Spot-Inhaber
- Erreichbar direkt aus dem Spot-Detail-Modal
- Offline-Nachrichten — werden zugestellt wenn der Empfänger wieder online ist

### 🔐 Datenschutz
- Eigener Standort wird **nicht** für andere sichtbar auf der Karte
- Nur Online-Status (● / ○) wird angezeigt — kein Rückschluss auf Standort möglich
- Spot-Fotos erst nach Admin-Freigabe sichtbar

### 📱 PWA
- Installierbar auf iOS und Android
- Offline-fähig via Service Worker
- Cache-Strategie: Static Files → Cache First, API → Network First mit 60s Fallback

---

## 🏗️ Technologie-Stack

| Bereich | Technologie |
|---|---|
| Frontend | Vanilla JS, HTML5, CSS3 |
| Karte | [MapLibre GL](https://maplibre.org/) |
| Tiles | [OpenFreeMap](https://openfreemap.org/) (Liberty/Bright Style) |
| Routing | [OSRM](https://project-osrm.org/) (Open Source Routing Machine) |
| Backend | Node.js + Express |
| Datenbank | PostgreSQL (via Render) |
| Realtime | PeerJS (WebRTC für Calls) |
| Hosting | GitHub Pages (Frontend) + Render (Backend) |
| Fonts | Google Fonts — Space Mono, Outfit |

---

## 📁 Dateistruktur

```
spotme-caching/
├── index.html              # Hauptkarte mit allen Features
├── spot-caching.html       # Spot-Karte (MapLibre)
├── profil-caching.html     # Profil erstellen / bearbeiten
├── admin.html              # Admin-Panel (Avatar + Spot-Bild Moderation)
├── 404.html                # Custom 404-Seite (PWA-Style)
├── manifest.json           # PWA Manifest
├── sw.js                   # Service Worker (Cache-Strategie)
└── server.js               # Backend (Node.js + Express + PostgreSQL)
```

---

## 🚀 Setup

### Voraussetzungen
- Node.js ≥ 18
- PostgreSQL Datenbank (z.B. via [Render](https://render.com/))

### Backend starten

```bash
npm install
DATABASE_URL=postgres://... ADMIN_KEY=dein-geheimes-key node server.js
```

### Environment Variables (Render)

| Variable | Beschreibung |
|---|---|
| `DATABASE_URL` | PostgreSQL Connection String |
| `ADMIN_KEY` | Geheimer Key für Admin-Panel |
| `CRYPTO_KEY` | 64-stelliger Hex-String für Datenverschlüsselung (`openssl rand -hex 32`) |
| `PORT` | Server-Port (Standard: 3000) |

### Frontend deployen

Alle HTML-Dateien auf GitHub Pages deployen. Der Service Worker wird automatisch registriert.

**Wichtig bei Updates:** `CACHE_VERSION` in `sw.js` hochzählen — sonst bekommen Nutzer die alte gecachte Version.

```js
const CACHE_VERSION = 'v6'; // bei jedem Deploy erhöhen
```

---

## 🗄️ Datenbank-Tabellen

| Tabelle | Inhalt |
|---|---|
| `profiles` | Nutzerprofile (verschlüsselt) |
| `user_spots` | Spots mit Koordinaten, Foto, Beschreibung |
| `spot_cache_requests` | SpotCache Anfragen |
| `offline_messages` | Nachrichten an offline Nutzer |
| `missed_calls` | Verpasste Anrufe |
| `verifications` | Persönliche Verifikationen |
| `profile_comments` | Story-Kommentare |

### Datenbank zurücksetzen (Entwicklung)

```sql
TRUNCATE TABLE spot_cache_requests RESTART IDENTITY CASCADE;
TRUNCATE TABLE profile_comments    RESTART IDENTITY CASCADE;
TRUNCATE TABLE offline_messages    RESTART IDENTITY CASCADE;
TRUNCATE TABLE missed_calls        RESTART IDENTITY CASCADE;
TRUNCATE TABLE verifications       RESTART IDENTITY CASCADE;
TRUNCATE TABLE user_spots          RESTART IDENTITY CASCADE;
TRUNCATE TABLE profiles            RESTART IDENTITY CASCADE;
```

---

## 🔒 Admin-Panel

Das Admin-Panel (`admin.html`) ermöglicht die Moderation von:
- **Avatar-Fotos** — Freigeben oder Ablehnen
- **Spot-Fotos** — Freigeben oder Ablehnen

Zugang mit `ADMIN_KEY` aus den Environment Variables.

Neue Fotos (Avatar + Spot) sind standardmäßig `pending` und erst nach Freigabe für andere Nutzer sichtbar.

---

## 🗺️ API-Endpunkte (Auswahl)

```
GET    /api/userspots/all          Alle Spots (ohne Bilder für Performance)
GET    /api/userspots/:code        Spots eines Nutzers
POST   /api/userspots              Neuen Spot anlegen
PUT    /api/userspots/:id          Spot bearbeiten
DELETE /api/userspots/:id          Spot löschen

POST   /api/profile                Profil erstellen/aktualisieren
GET    /api/profile/:code          Profil abrufen
POST   /api/avatar                 Avatar hochladen (→ pending)
GET    /api/avatar/:code           Avatar abrufen (nur approved)

POST   /api/spotcache/invite       Einladung senden
GET    /api/spotcache/invites/:code Eigene Einladungen
POST   /api/spotcache/invite/respond Einladung akzeptieren/ablehnen
POST   /api/spotcache/checkin      Check-in am Spot

GET    /api/admin/pending-avatars         Avatar-Moderation
POST   /api/admin/avatar-action          Avatar freigeben/ablehnen
GET    /api/admin/pending-spot-images    Spot-Bild-Moderation
POST   /api/admin/spot-image-action      Spot-Bild freigeben/ablehnen
```

---

## 🔮 Roadmap

- [ ] Spot-Liste pro Profil (öffentlich sichtbar)
- [ ] Kategorie-System für Spots (Dates / Locations / Geocaching)
- [ ] Spot-Ablaufdatum
- [ ] Wish-Tag-Filter auf der Karte
- [ ] Marker-Clustering bei vielen Spots
- [ ] Haptic Feedback (Mobile)

---

## 📜 Lizenz

MIT — Open Source. Nutzung, Modifikation und Weitergabe erlaubt.

---

## 👤 Autor

**Dragons Chain** · Costa Brava, Spanien  
Entwickelt im SpotMe Ökosystem — radikal transparent, zero-profit.

> *"Nicht jeder Spot ist auf der Karte. Manche muss man sich verdienen."*
