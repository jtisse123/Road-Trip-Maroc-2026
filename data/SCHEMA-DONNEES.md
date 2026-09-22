# Schéma des données — `roadtrip.json`

Ce fichier décrit la structure attendue de `data/roadtrip.json`. Il permet de modifier les données à la main ou de **remplacer entièrement** le fichier par une nouvelle version générée par un autre outil (ChatGPT, script…), sans réécrire l'application.

L'application lit `data/roadtrip.json` (via le lanceur ou en ligne) et, en repli lors d'une ouverture directe du fichier (`file://`), la copie `data/roadtrip.js` (qui contient `window.ROADTRIP_DATA = { … }` — le même objet). **Si vous modifiez le JSON, pensez à régénérer le `.js`** (voir en bas) ou utilisez simplement le lanceur, qui lit directement le JSON.

## Objet racine

```jsonc
{
  "meta":       { … },          // informations générales du voyage
  "categories": { … },          // dictionnaire catégorie -> { label, emoji }
  "days":       [ … ],          // les 10 journées
  "places":     [ … ],          // tous les lieux (le cœur des données)
  "routes":     { … }           // FeatureCollection GeoJSON des tracés
}
```

## `meta`

```jsonc
{
  "title": "Road Trip Maroc",
  "subtitle": "26 décembre 2026 → 4 janvier 2027 · 10 jours · 9 nuits",
  "startDate": "2026-12-26",
  "endDate": "2027-01-04",
  "totalKm": 1975,
  "coordNote": "…", "routeNote": "…",
  "detourClasses": { "sur_la_route": "…", "petit_detour": "…", "detour_interessant": "…" },
  "statusLegend":  { "verifie": "…", "a_reconfirmer": "…", "incertain": "…" }
}
```

## `categories`

Dictionnaire `clé -> { label, emoji }`. La `clé` est la valeur utilisée dans le champ `category` des lieux.

```jsonc
"categories": {
  "restaurant": { "label": "Restaurant", "emoji": "🍴" },
  "kasbah":     { "label": "Kasbah / ksar", "emoji": "🏰" },
  "vigilance":  { "label": "Vigilance / route hivernale", "emoji": "⚠️" }
  // …
}
```

Catégories utilisées : `restaurant, cafe, hebergement, patrimoine, medina, souk, artisanat, kasbah, randonnee, promenade, panorama, photo, desert, oasis, gorge, nature, activite, escalade, musique, bonus, station, parking, vigilance`.

## `days` (tableau de 10 objets)

```jsonc
{
  "id": "day-06",
  "num": 6,
  "date": "Jeu. 31/12",
  "label": "Todra → Rissani → Merzouga",
  "start": "Todra", "end": "Merzouga",
  "night": "Merzouga / camp",
  "km": 230,
  "drive": "4–4 h 30",
  "intensity": "🟠",
  "color": "#8E5572"          // couleur de la journée (tracé + puce)
}
```

## `places` (tableau — le cœur des données)

Champs communs à tous les lieux :

| Champ | Type | Description |
|---|---|---|
| `id` | texte | Identifiant unique (`L001`…, `R1`… pour randos, `V1`… vigilance, `H1`… nuits, `U…` = ajouté par l'utilisateur). |
| `name` | texte | Nom du lieu. |
| `category` | texte | Une des clés de `categories`. |
| `categoryLabel` | texte | Libellé lisible (facultatif, déduit sinon). |
| `emoji` | texte | Emoji affiché sur l'épingle. |
| `region` | texte | Étape / région. |
| `days` | tableau d'entiers | Journées où le lieu est pertinent, ex. `[4,5]`. `[]` = disponible tout le temps. |
| `lat`, `lon` | nombres ou `null` | Latitude / longitude en degrés décimaux. `null` si inconnu. |
| `coordPrecision` | `"precise"` \| `"zone"` \| `null` | Fiabilité de la position (voir ci-dessous). |
| `interest` | 1–5 ou `null` | Intérêt sur 5. |
| `duree` | texte ou `null` | Temps conseillé, ex. `"30–45 min"`. |
| `detour` | texte ou `null` | Détour, ex. `"sur la route"`, `"+10–20 min A/R"`. |
| `detourClass` | `"sur_la_route"` \| `"petit_detour"` \| `"detour_interessant"` \| `null` | Classe de détour (pour le filtre). |
| `desc` | texte ou `null` | Description courte. |
| `mapsUrl` | URL ou `null` | Lien Google Maps (localisateur de référence). |
| `status` | `"verifie"` \| `"a_reconfirmer"` \| `"incertain"` \| `null` | Fiabilité de l'information. |
| `statusLabel` | texte | Libellé du statut (facultatif). |
| `sourceUrl` | URL ou `null` | Source documentaire (facultatif). |

**`coordPrecision`** :
- `"precise"` — site ou ville identifié, position fiable au niveau attendu ;
- `"zone"` — position **approximative** dans le secteur (l'application l'indique clairement) ;
- `null` — coordonnées absentes (« à compléter ») ; le lieu apparaît dans les listes mais pas sur la carte.

> **Ne fabriquez pas de fausses coordonnées.** Si vous ne connaissez pas la position exacte, mettez `lat`/`lon` à `null` et `coordPrecision` à `null`, ou une position de secteur avec `"zone"`.

Champs **supplémentaires pour les restaurants** (`category: "restaurant"`) : `restoType`, `budget`, `commander`.

Champs **supplémentaires pour les randonnées** (`category: "randonnee"`) : `depart`, `distance`, `duree_rando`, `denivele`, `difficulte`, `boucle`, `hiver`, `guide`.

## `routes` (GeoJSON `FeatureCollection`)

Une `Feature` de type `LineString` par journée. Les coordonnées sont au format GeoJSON **`[longitude, latitude]`** et suivent les villes traversées (corridor indicatif, pas un calcul routier).

```jsonc
{
  "type": "Feature",
  "properties": { "day": 6, "dayId": "day-06", "label": "Todra → Rissani → Merzouga",
                  "km": 230, "drive": "4–4 h 30", "color": "#8E5572",
                  "night": "Merzouga / camp", "kind": "principale" },
  "geometry": { "type": "LineString",
                "coordinates": [ [-5.596,31.585], [-5.533,31.515], … ] }
}
```

## Format d'export / import personnel

Le bouton ⚙️ exporte un fichier distinct (vos données personnelles uniquement) :

```jsonc
{
  "app": "road-trip-maroc",
  "version": 1,
  "exportedAt": "2026-12-31T18:00:00.000Z",
  "statuses": { "L001": "fav", "L045": "done" },   // fav | want | done | skip
  "added":    [ /* lieux ajoutés, même format que places, id commençant par "U" */ ]
}
```

## Régénérer `roadtrip.js` après modification du JSON

`roadtrip.js` n'est utile que pour l'ouverture directe du fichier (`file://`). Pour le régénérer à partir du JSON, dans un terminal placé dans le dossier `data` :

```
python3 -c "import json;d=open('roadtrip.json',encoding='utf-8').read();open('roadtrip.js','w',encoding='utf-8').write('window.ROADTRIP_DATA = '+d+';\n')"
```

Si vous utilisez toujours le lanceur « Ouvrir Road Trip », cette étape est inutile (le JSON est lu directement).
