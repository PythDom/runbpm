import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { haversine, parseGpx, parseJsonRoute, parseRouteFile, parseTcx } from '../src/core/route';

describe('haversine', () => {
  it('mesure environ 111 km par degré de latitude', () => {
    expect(haversine(45, 6, 46, 6)).toBeCloseTo(111_195, -2);
  });
});

describe('parseGpx', () => {
  it('lit les points de trace, les altitudes et le nom', () => {
    const gpx = `<gpx><trk><name>Test &amp; co</name><trkseg>
      <trkpt lat="45.0" lon="6.0"><ele>100</ele></trkpt>
      <trkpt lon="6.0" lat="45.001"><ele>110</ele><time>x</time></trkpt>
      <trkpt lat='45.002' lon='6.0'/>
    </trkseg></trk></gpx>`;
    const r = parseGpx(gpx);
    expect(r.name).toBe('Test & co');
    expect(r.points).toHaveLength(3);
    expect(r.totalDistance).toBeCloseTo(222.4, 0);
    expect(r.points[1].ele).toBe(110);
    // Altitude manquante en fin de trace : on garde la dernière connue.
    expect(r.points[2].ele).toBe(110);
    expect(r.warnings.length).toBe(1);
  });

  it('préfère la trace à la route quand les deux existent', () => {
    const gpx = `<gpx><rte><rtept lat="0" lon="0"/><rtept lat="1" lon="0"/></rte>
      <trk><trkseg><trkpt lat="0" lon="0"/><trkpt lat="0.001" lon="0"/></trkseg></trk></gpx>`;
    expect(parseGpx(gpx).totalDistance).toBeLessThan(200);
  });

  it('lit le fichier d’exemple', () => {
    const r = parseGpx(readFileSync('public/samples/boucle-vallonnee.gpx', 'utf8'));
    expect(r.points.length).toBeGreaterThan(900);
    expect(r.totalDistance).toBeGreaterThan(9000);
  });

  it('refuse un parcours sans points', () => {
    expect(() => parseGpx('<gpx></gpx>')).toThrow();
  });
});

describe('parseTcx', () => {
  it('utilise DistanceMeters quand il est présent', () => {
    const tcx = `<TrainingCenterDatabase><Activities><Activity><Id>Run</Id><Lap><Track>
      <Trackpoint><DistanceMeters>0</DistanceMeters><AltitudeMeters>10</AltitudeMeters></Trackpoint>
      <Trackpoint><DistanceMeters>500</DistanceMeters><AltitudeMeters>30</AltitudeMeters></Trackpoint>
    </Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
    const r = parseTcx(tcx);
    expect(r.totalDistance).toBe(500);
    expect(r.points[1].ele).toBe(30);
  });
});

describe('parseJsonRoute', () => {
  it('accepte un profil distance/altitude', () => {
    const r = parseJsonRoute(JSON.stringify({ name: 'P', profile: [{ distance: 0, ele: 0 }, [1000, 50]] }));
    expect(r.totalDistance).toBe(1000);
    expect(r.points[1].ele).toBe(50);
  });

  it('accepte des points lat/lon', () => {
    const r = parseJsonRoute(JSON.stringify({ points: [{ lat: 0, lon: 0, ele: 1 }, { lat: 0, lng: 0.01, elevation: 2 }] }));
    expect(r.totalDistance).toBeGreaterThan(1000);
  });

  it('détecte le format par le contenu', () => {
    expect(parseRouteFile('x.txt', '{"profile":[[0,0],[10,1]]}').totalDistance).toBe(10);
  });
});
