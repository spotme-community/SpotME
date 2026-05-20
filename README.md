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
- **Spot deaktivieren / reaktivieren** — Soft Delete: Spot bleibt in der Datenbank erhalten, verschwindet aber von der Karte bis er wieder aktiviert wird
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
- **Account-Backup & Restore** — vollständiger Export als JSON-Datei inkl. Code + Token; nach Cache-Löschen oder Gerätewechsel vollständig wiederherstellbar durch Serverabgleich

### 📨 Einladungssystem
- Einladung an Spot-Inhaber senden (Zeitraum wählen)
- Akzeptieren / Ablehnen
- Check-in per GPS wenn beide am Spot sind (50m-Radius-Prüfung)
- Match-Screen bei gegenseitigem Check-in + automatische gegenseitige Verifikation
- **Abgelaufene Einladungen** werden automatisch archiviert (`expired`) und in einem zusammenklappbaren "Vergangene Treffen"-Bereich angezeigt — nach 30 Tagen automatisch gelöscht

### 💬 Chat & Messenger
- Direktnachrichten zwischen Nutzer und Spot-Inhaber — **ohne vorherige Einladung** erreichbar direkt aus dem Spot-Detail-Modal
- **Chat-Liste** (WhatsApp-Style) mit Vorschautext, Uhrzeit und Ungelesen-Zähler pro Gespräch
- **Hintergrund-Benachrichtigung** — neues Chat-Icon in der Topbar pulsiert mit Badge-Zähler wenn neue Nachrichten eingegangen sind, auch wenn die App im Hintergrund läuft
- Offline-Nachrichten — werden zugestellt wenn der Empfänger wieder online ist
- Nachrichten werden clientseitig im localStorage gespeichert für sofortige Anzeige

### 🔐 Datenschutz
- Eigener Standort wird **nicht** für andere sichtbar auf der Karte
- Nur Online-Status (● / ○) wird angezeigt — kein Rückschluss auf Standort möglich
- Spot-Fotos erst nach Admin-Freigabe sichtbar
- Alle Profildaten werden serverseitig mit **AES-256-CBC** verschlüsselt gespeichert

### 📱 PWA
- Installierbar auf iOS und Android
- Offline-fähig via Service Worker
- Cache-Strategie: Static Files → Stale-While-Revalidate, API → immer Network (niemals gecacht)
- `CACHE_VERSION` in `sw.js` bei jedem Deploy hochzählen um Nutzer auf den neuesten Stand zu bringen

---

## 🏗️ Technologie-Stack

| Bereich | Technologie |
|---|---|
| Frontend | Vanilla JS, HTML5, CSS3 — keine Frameworks, keine Dependencies |
| Karte | [MapLibre GL](https://maplibre.org/) |
| Tiles | [OpenFreeMap](https://openfreemap.org/) (Liberty Style) |
| Routing | [OSRM](https://project-osrm.org/) (Open Source Routing Machine) |
| Backend | Node.js + Express |
| Datenbank | PostgreSQL via [Neon](https://neon.tech/) (Serverless) |
| Hosting | GitHub Pages (Frontend) + [Render](https://render.com/) (Backend) |
| Verschlüsselung | AES-256-CBC via Node.js `crypto` |
| Fonts | Google Fonts — Space Mono, Outfit |

---

## 📁 Dateistruktur

```
spotme-caching/
├── index.html              # Hauptkarte — Spots, Navigation, Einladungen, Chat
├── profil-caching.html     # Profil erstellen / bearbeiten / Backup
├── admin.html              # Admin-Panel (Avatar + Spot-Bild Moderation)
├── 404.html                # Custom 404-Seite (PWA-Style)
├── manifest.json           # PWA Manifest
├── sw.js                   # Service Worker (Cache-Strategie)
└── server.js               # Backend (Node.js + Express + PostgreSQL)
```

---

## 🚀 Setup

### Voraussetzungen
Node.js ≥ 18 und eine PostgreSQL-Datenbank (z.B. via [Neon](https://neon.tech/) oder [Render](https://render.com/)) werden benötigt.

### Backend starten

```bash
npm install
DATABASE_URL=postgres://... ADMIN_KEY=dein-geheimes-key CRYPTO_KEY=$(openssl rand -hex 32) node server.js
```

### Environment Variables (Render)

| Variable | Beschreibung |
|---|---|
| `DATABASE_URL` | PostgreSQL Connection String (von Neon oder Render) |
| `ADMIN_KEY` | Geheimer Key für Admin-Panel |
| `CRYPTO_KEY` | 64-stelliger Hex-String für AES-256-Datenverschlüsselung (`openssl rand -hex 32`) |
| `PORT` | Server-Port (Standard: 3000, wird von Render automatisch gesetzt) |

### Frontend deployen

Alle HTML-Dateien auf GitHub Pages deployen. Der Service Worker wird automatisch registriert.

**Wichtig bei jedem Update:** `CACHE_VERSION` in `sw.js` hochzählen — sonst erhalten Nutzer weiterhin die alte gecachte Version, da der Browser nicht weiß dass sich etwas geändert hat.

```js
const CACHE_VERSION = 'v9'; // bei jedem Deploy um 1 erhöhen
```

### Datenbank einrichten

Die Tabellen werden beim ersten Serverstart automatisch durch `initDB()` erstellt. Für das Spot-Deaktivierungs-Feature muss einmalig diese Migration in Neon ausgeführt werden:

```sql
ALTER TABLE user_spots ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;
```

---

## 🗄️ Datenbank-Tabellen

| Tabelle | Inhalt |
|---|---|
| `profiles` | Nutzerprofile (verschlüsselt via AES-256) |
| `user_spots` | Spots mit Koordinaten, Foto, Beschreibung, `active`-Status |
| `spot_cache_invites` | Treffpunkt-Einladungen mit Zeitfenstern und Status-Lifecycle |
| `spot_cache_requests` | SpotCache Anfragen (Legacy) |
| `offline_messages` | Nachrichten an offline Nutzer + Chat-Nachrichten (`spot_type`) |
| `missed_calls` | Verpasste Anrufe |
| `verifications` | Persönliche Verifikationen nach erfolgreichem Check-in |
| `profile_comments` | Story-Kommentare |

### Datenbank zurücksetzen (nur Entwicklung)

```sql
TRUNCATE TABLE spot_cache_invites   RESTART IDENTITY CASCADE;
TRUNCATE TABLE spot_cache_requests  RESTART IDENTITY CASCADE;
TRUNCATE TABLE profile_comments     RESTART IDENTITY CASCADE;
TRUNCATE TABLE offline_messages     RESTART IDENTITY CASCADE;
TRUNCATE TABLE missed_calls         RESTART IDENTITY CASCADE;
TRUNCATE TABLE verifications        RESTART IDENTITY CASCADE;
TRUNCATE TABLE user_spots           RESTART IDENTITY CASCADE;
TRUNCATE TABLE profiles             RESTART IDENTITY CASCADE;
```

---

## 🔒 Admin-Panel

Das Admin-Panel (`admin.html`) ermöglicht die Moderation von Avatar-Fotos (Freigeben oder Ablehnen) und Spot-Fotos (Freigeben oder Ablehnen). Der Zugang erfolgt mit dem `ADMIN_KEY` aus den Environment Variables. Neue Fotos sind standardmäßig `pending` und erst nach manueller Freigabe für andere Nutzer sichtbar.

---

## 🗺️ API-Endpunkte

```
GET    /api/userspots/all               Alle aktiven Spots (WHERE active = true)
GET    /api/userspots/:code             Spots eines Nutzers
POST   /api/userspots                   Neuen Spot anlegen (active = true)
PUT    /api/userspots/:id               Spot bearbeiten
PATCH  /api/userspots/:id/toggle        Spot aktivieren / deaktivieren (Soft Delete)
DELETE /api/userspots/:id               Spot endgültig löschen

POST   /api/profile                     Profil erstellen / aktualisieren
GET    /api/profile/:code               Profil abrufen (entschlüsselt)
POST   /api/avatar                      Avatar hochladen (→ pending)
GET    /api/avatar/:code                Avatar abrufen (nur approved)

POST   /api/spotcache/invite            Einladung senden (mit Zeitfenster)
GET    /api/spotcache/invites/:code     Einladungen abrufen (inkl. expired)
POST   /api/spotcache/invite/respond    Einladung akzeptieren / ablehnen
POST   /api/spotcache/checkin           Check-in am Spot (50m-Radius-Prüfung)

POST   /api/message                     Chat-Nachricht senden
GET    /api/messages/:code              Chat-Nachrichten abrufen

GET    /api/admin/pending-avatars       Avatar-Moderation
POST   /api/admin/avatar-action         Avatar freigeben / ablehnen
GET    /api/admin/pending-spot-images   Spot-Bild-Moderation
POST   /api/admin/spot-image-action     Spot-Bild freigeben / ablehnen
```

---

## 🔮 Roadmap

### ✅ Bereits implementiert
- [x] Spot setzen, bearbeiten, löschen
- [x] Einladungssystem mit Zeitfenstern
- [x] GPS Check-in mit 50m-Radius-Prüfung
- [x] Gegenseitige Verifikation nach Check-in
- [x] Chat direkt aus Spot-Detail (ohne vorherige Einladung)
- [x] Chat-Liste mit Ungelesen-Badge
- [x] Hintergrund-Benachrichtigung für neue Nachrichten
- [x] Abgelaufene Einladungen archivieren (Soft Expire nach 30 Tagen)
- [x] Spot deaktivieren / reaktivieren (Soft Delete)
- [x] Account-Backup & Restore per JSON-Datei
- [x] AES-256-Verschlüsselung aller Profildaten
- [x] Avatar- und Spot-Foto-Moderation durch Admin
- [x] Service Worker mit intelligenter Cache-Strategie
- [x] Open-Meteo der Dir das Wetter für die nächsten 8 Stunden für den Spot zeigt.

### 🔜 Demnächst geplant
- [ ] **Spot-Besuchshistorie** — nach einem erfolgreichen Check-in wird der Spot in einer persönlichen "Bereits besucht"-Liste gespeichert, die im Profil einsehbar ist
- [ ] **Wish-Tag-Filter auf der Karte** — Nutzer können die Karte nach bestimmten Wunsch-Tags filtern um nur relevante Spots zu sehen
- [ ] **Einladungs-Benachrichtigung** — ähnlich wie der Chat-Badge soll ein pulsierender Badge erscheinen wenn eine neue Einladung eingegangen ist, auch wenn die App im Hintergrund läuft
- [ ] **Marker-Clustering** — bei vielen Spots in einem Bereich werden diese zu einer Gruppe zusammengefasst um die Karte übersichtlich zu halten
- [ ] **Spot-Kategorie-System** — Spots können einer Kategorie zugewiesen werden (z.B. Natur, Stadt, Geheim) um die Suche zu verbessern
- [ ] **Öffentliche Spot-Liste im Profil** — alle Spots eines Nutzers sind auf seinem öffentlichen Profil einsehbar
- [ ] **Haptic Feedback** — kurze Vibration bei wichtigen Aktionen (Check-in erfolgreich, neue Nachricht)
- [ ] **Spot-Ablaufdatum** — Eigentümer kann einen Zeitraum setzen nach dem der Spot automatisch deaktiviert wird

---

## 📜 Lizenz

MIT — Open Source. Nutzung, Modifikation und Weitergabe erlaubt.

---

## 👤 Autor

**Dragons Chain** · Costa Brava, Spanien  
Entwickelt im SpotMe Ökosystem — radikal transparent, zero-profit.

> *"Nicht jeder Spot ist auf der Karte. Manche muss man sich verdienen."*
