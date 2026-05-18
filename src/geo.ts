export function haversineMeters(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLon = toRad(bLon - aLon)
  const la1 = toRad(aLat)
  const la2 = toRad(bLat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

interface OsrmRouteResponse {
  code: string
  routes: Array<{
    geometry: { coordinates: Array<[number, number]> }
    legs: Array<{ duration: number; distance: number }>
  }>
}

export interface OsrmLeg {
  duration: number  // segundos
  distance: number  // metros
}

export interface OsrmRouteResult {
  coords: Array<[number, number]>  // [lat, lng]
  legs: OsrmLeg[]
}

/**
 * Obtiene la ruta peatonal real desde OSRM (router.project-osrm.org).
 * Devuelve coords + legs (duración/distancia por tramo) o null si falla.
 */
export async function fetchOsrmWalkRoute(
  waypoints: Array<[number, number]>,
  signal?: AbortSignal,
): Promise<OsrmRouteResult | null> {
  if (waypoints.length < 2) return null
  const coords = waypoints.map(([lat, lng]) => `${lng},${lat}`).join(';')
  const url = `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${coords}?overview=full&geometries=geojson`
  try {
    const res = await fetch(url, signal ? { signal } : undefined)
    if (!res.ok) return null
    const data = (await res.json()) as OsrmRouteResponse
    if (data.code !== 'Ok' || !data.routes?.[0]?.geometry?.coordinates) return null
    return {
      // OSRM devuelve [lng, lat] → convertir a [lat, lng]
      coords: data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      legs: data.routes[0].legs.map((l) => ({ duration: l.duration, distance: l.distance })),
    }
  } catch {
    return null
  }
}

/** Greedy orden por vecino más cercano desde un punto de partida. */
export function sortIdsByNearestNeighbor(
  ids: string[],
  startLat: number,
  startLon: number,
  coordById: Map<string, [number, number]>,
): string[] {
  const remaining = new Set(ids)
  const out: string[] = []
  let curLat = startLat
  let curLon = startLon

  while (remaining.size > 0) {
    let bestId: string | undefined
    let bestD = Infinity
    for (const id of remaining) {
      const c = coordById.get(id)
      if (!c) continue
      const [lat, lon] = c
      const d = haversineMeters(curLat, curLon, lat, lon)
      if (d < bestD) {
        bestD = d
        bestId = id
      }
    }
    if (!bestId) break
    remaining.delete(bestId)
    out.push(bestId)
    const c = coordById.get(bestId)
    if (c) {
      const [lat, lon] = c
      curLat = lat
      curLon = lon
    }
  }
  return out
}
