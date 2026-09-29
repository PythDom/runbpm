// Génère les fichiers d'exemple de public/samples (parcours GPX, profil JSON, bibliothèque CSV).
import { writeFileSync } from 'node:fs';

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

// Profil d'altitude (distance en m -> altitude) d'une boucle vallonnée de 10 km.
const legs = [
  [2000, 0], // plat
  [1500, 0.06], // montée à 6 %
  [800, 0.01],
  [700, 0.09], // raidard à 9 %
  [1500, -0.02],
  [1200, -0.07], // descente
  [800, 0.03],
  [1500, -0.071 / 1.5], // retour à l’altitude de départ
];
const total = legs.reduce((s, l) => s + l[0], 0);
const eleAt = (d) => {
  let ele = 420;
  let acc = 0;
  for (const [len, g] of legs) {
    const part = Math.min(len, Math.max(0, d - acc));
    ele += part * g;
    acc += len;
  }
  return ele;
};

// Boucle (ellipse déformée) autour d'un point fictif.
const lat0 = 45.9;
const lon0 = 6.12;
const pts = [];
const step = 10;
for (let d = 0; d <= total; d += step) {
  const a = (d / total) * 2 * Math.PI;
  const r = total / (2 * Math.PI);
  const x = r * Math.cos(a) * 1.3 + 40 * Math.sin(3 * a);
  const y = r * Math.sin(a) * 0.75;
  const lat = lat0 + y / 111_320;
  const lon = lon0 + x / (111_320 * Math.cos((lat0 * Math.PI) / 180));
  const ele = eleAt(d) + (rand() - 0.5) * 2.5; // bruit type GPS
  pts.push([lat, lon, ele]);
}
const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RunBPM samples" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Boucle vallonnée (exemple)</name></metadata>
  <trk>
    <name>Boucle vallonnée (exemple)</name>
    <trkseg>
${pts.map(([la, lo, e]) => `      <trkpt lat="${la.toFixed(6)}" lon="${lo.toFixed(6)}"><ele>${e.toFixed(1)}</ele></trkpt>`).join('\n')}
    </trkseg>
  </trk>
</gpx>
`;
writeFileSync('public/samples/boucle-vallonnee.gpx', gpx);

const profile = {
  name: 'Profil simple (exemple JSON)',
  profile: [
    { distance: 0, ele: 100 },
    { distance: 2000, ele: 100 },
    { distance: 3000, ele: 150 },
    { distance: 4000, ele: 150 },
    { distance: 5000, ele: 100 },
  ],
};
writeFileSync('public/samples/profil-simple.json', JSON.stringify(profile, null, 2) + '\n');

const csv = `title,artist,bpm,duration,file
Morceau exemple A,Artiste fictif,170,3:32,musique/morceau-a.mp3
Morceau exemple B,Artiste fictif,176,4:05,musique/morceau-b.mp3
Morceau exemple C (mi-tempo),Artiste fictif,88,3:48,musique/morceau-c.mp3
Morceau exemple D,Autre artiste,182,3:15,musique/morceau-d.mp3
`;
writeFileSync('public/samples/bibliotheque-exemple.csv', csv);
console.log(`GPX : ${pts.length} points, ${total} m`);
