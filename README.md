# RunBPM

Génère une playlist dont le tempo (BPM) suit la **cadence de course idéale** tout au long d’un parcours,
en tenant compte du **dénivelé** et de l’**allure désirée**. Le coureur cale ses pas sur la musique et garde
naturellement la bonne cadence, en montée comme en descente.

Application web 100 % locale : tout est calculé dans le navigateur, aucun fichier n’est envoyé.

## Démarrage

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # tests unitaires (vitest)
npm run build    # version statique dans dist/ (déployable telle quelle, ex. GitHub Pages)
```

Dans l’application : cliquez sur « Essayer la boucle vallonnée d’exemple » puis « Utiliser la bibliothèque de démo ».

## Fonctionnement

1. **Parcours** → rééchantillonné tous les 20 m, altitude lissée (bruit GPS), puis découpé en
   **sections de pente homogène** (≥ 250 m, voisines de pente similaire fusionnées).
2. **Plan de course** → pour chaque section : vitesse, temps de passage et cadence cible.
   - *Allure constante* : même vitesse partout.
   - *Effort constant* : vitesse modulée par le coût énergétique de la pente (Minetti et al., 2002,
     atténué et borné), en conservant l’allure moyenne demandée.
   - Cadence = cadence sur le plat (saisie par le coureur, ou estimée : ≈ 140 + 3 × vitesse en km/h)
     \+ 0,6 pas/min par % de montée, + 0,3 pas/min par % de descente (réglables).
3. **Playlist** → on avance dans le temps de course et on choisit à chaque fois le morceau dont le tempo
   colle le mieux à la cadence cible **sur toute sa durée d’écoute** (la cadence peut changer en cours de morceau).
   - *Mi-tempo* : un morceau à 88 BPM convient pour 176 pas/min (un pas par demi-temps).
   - *Ajustement de tempo* : vitesse de lecture conseillée, ±4 % max par défaut (quasi inaudible).
   - Les morceaux naturellement au bon tempo sont préférés ; « Autre proposition » donne une variante.
4. **Exports** : M3U (lecteurs audio), CSV, JSON (plan + playlist).

## Formats d’entrée

### Parcours
- **GPX** (`<trkpt>` ou `<rtept>` avec `<ele>`) : export de Strava, Garmin, Komoot, OpenRunner…
- **TCX** (Garmin, `AltitudeMeters`, `DistanceMeters`).
- **JSON RunBPM**, deux variantes :

```json
{ "name": "Mon parcours", "points": [ { "lat": 45.90, "lon": 6.12, "ele": 420 } ] }
{ "name": "Profil seul",  "profile": [ { "distance": 0, "ele": 100 }, { "distance": 2000, "ele": 160 } ] }
```
(`distance` en mètres depuis le départ ; `profile` accepte aussi des couples `[distance, altitude]`.)

### Bibliothèque musicale
CSV (séparateur `,` `;` ou tabulation) ou JSON. Colonnes reconnues (FR/EN) :

| Champ | Noms acceptés | Obligatoire |
|---|---|---|
| Tempo | `bpm`, `tempo` | oui |
| Durée | `duration`, `durée`, `duration (ms)`, `length`… (`3:45`, secondes ou ms) | oui |
| Titre | `title`, `titre`, `track name`, `name`… | non |
| Artiste | `artist`, `artiste`, `artist name(s)`… | non |
| Fichier | `file`, `fichier`, `path`, `url` (repris dans le M3U) | non |

Les exports de playlists au format *Exportify* (colonnes `Track Name`, `Artist Name(s)`, `Duration (ms)`, `Tempo`)
sont reconnus directement. Exemple : [`public/samples/bibliotheque-exemple.csv`](public/samples/bibliotheque-exemple.csv).
La bibliothèque importée est mémorisée dans le navigateur.

## Organisation du code

```
src/core/     moteur, sans dépendance au DOM (testé)
  route.ts      lecture GPX / TCX / JSON, distances (haversine), altitudes manquantes
  sections.ts   rééchantillonnage, lissage, découpage en sections de pente
  pacing.ts     plan de course : vitesse, cadence, modèle de Minetti
  library.ts    import CSV/JSON des morceaux
  playlist.ts   sélection des morceaux
  export.ts     M3U / CSV / JSON
  demo.ts       bibliothèque fictive de démonstration
src/ui/       interface (TypeScript sans framework) et graphique SVG
tests/        tests vitest
scripts/generate-samples.mjs   régénère les fichiers d’exemple
```

## Pistes d’évolution
- Lecture intégrée des fichiers audio locaux avec ajustement du tempo (Web Audio, `playbackRate` + `preservesPitch`).
- Détection automatique du BPM des fichiers audio importés.
- Connexion à un service de streaming (création de la playlist directement dans le compte).
- Calibrage personnel de la cadence à partir d’une sortie enregistrée (fichier FIT/TCX avec cadence).
- Transitions synchronisées sur les changements de section.
