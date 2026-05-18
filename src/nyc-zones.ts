/**
 * Cinco zonas amplias (rectángulos). Prioridad menor = se evalúa antes si hay solape.
 */

export interface ZoneBBox {
  id: string
  label: string
  priority: number
  sw: [number, number]
  ne: [number, number]
}

export const NYC_ZONES: ZoneBBox[] = [
  {
    id: 'manhattan',
    label: 'Manhattan',
    priority: 10,
    sw: [40.699, -74.047],
    ne: [40.881, -73.865],
  },
  {
    id: 'brooklyn',
    label: 'Brooklyn',
    priority: 20,
    sw: [40.561, -74.052],
    ne: [40.739, -73.825],
  },
  {
    id: 'queens',
    label: 'Queens',
    priority: 30,
    sw: [40.545, -73.962],
    ne: [40.813, -73.695],
  },
  {
    id: 'bronx',
    label: 'El Bronx',
    priority: 40,
    sw: [40.786, -73.935],
    ne: [40.915, -73.748],
  },
  {
    id: 'staten-nj',
    label: 'Staten Island y Nueva Jersey',
    priority: 50,
    sw: [40.475, -74.285],
    ne: [40.858, -73.995],
  },
]

const sortedZones = [...NYC_ZONES].sort((a, b) => a.priority - b.priority)

export function pointInZoneBBox(
  lat: number,
  lng: number,
  sw: [number, number],
  ne: [number, number],
): boolean {
  return lat >= sw[0] && lat <= ne[0] && lng >= sw[1] && lng <= ne[1]
}

export function inferZoneId(lat: number, lng: number): string {
  for (const z of sortedZones) {
    if (pointInZoneBBox(lat, lng, z.sw, z.ne)) return z.id
  }
  return 'nyc-otros'
}

export const FALLBACK_ZONE_LABEL = 'Fuera de estas zonas'

const labelById = new Map<string, string>(
  NYC_ZONES.map((z) => [z.id, z.label] as const),
)

export function zoneLabel(zoneId: string): string {
  return labelById.get(zoneId) ?? FALLBACK_ZONE_LABEL
}

export function zoneBoundsLeaflet(zoneId: string): [[number, number], [number, number]] | null {
  const z = NYC_ZONES.find((x) => x.id === zoneId)
  if (!z) return null
  return [
    [z.sw[0], z.sw[1]],
    [z.ne[0], z.ne[1]],
  ]
}
