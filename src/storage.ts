import type { PoiFeature, RouteDay, RoutesPayload, ViaPoint } from './types.ts'

const K_VISITED = 'nyc-map-visited-v1'
const K_USER_POIS = 'nyc-map-user-pois-v1'
const K_ROUTES = 'nyc-map-routes-v1'
const K_PHOTOS = 'nyc-map-photos-v1'

export function loadVisited(): Set<string> {
  try {
    const raw = localStorage.getItem(K_VISITED)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

export function saveVisited(ids: Set<string>): void {
  localStorage.setItem(K_VISITED, JSON.stringify([...ids]))
}

export function loadUserPois(): PoiFeature[] {
  try {
    const raw = localStorage.getItem(K_USER_POIS)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isPoiFeature)
  } catch {
    return []
  }
}

export function saveUserPois(features: PoiFeature[]): void {
  localStorage.setItem(K_USER_POIS, JSON.stringify(features))
}

export function loadRoutes(): RoutesPayload {
  try {
    const raw = localStorage.getItem(K_ROUTES)
    if (!raw) return defaultRoutes()
    const parsed = JSON.parse(raw) as RoutesPayload
    if (!parsed.days || !Array.isArray(parsed.days)) return defaultRoutes()
    const days = parsed.days
      .filter(
        (d): d is RouteDay =>
          typeof d === 'object' &&
          d !== null &&
          typeof d.id === 'string' &&
          typeof d.label === 'string' &&
          Array.isArray(d.stopIds),
      )
      .map((d) => ({
        id: d.id,
        label: d.label,
        stopIds: d.stopIds.filter((x): x is string => typeof x === 'string'),
        viaPoints: Array.isArray(d.viaPoints) ? d.viaPoints.filter(isViaPoint) : [],
      }))
    return days.length ? { days } : defaultRoutes()
  } catch {
    return defaultRoutes()
  }
}

export function saveRoutes(payload: RoutesPayload): void {
  localStorage.setItem(K_ROUTES, JSON.stringify(payload))
}

function defaultRoutes(): RoutesPayload {
  return {
    days: [{ id: 'day-1', label: 'Día 1', stopIds: [] }],
  }
}

export function loadPhotos(): Map<string, string> {
  try {
    const raw = localStorage.getItem(K_PHOTOS)
    if (!raw) return new Map()
    const obj = JSON.parse(raw) as Record<string, unknown>
    return new Map(
      Object.entries(obj).filter((e): e is [string, string] => typeof e[1] === 'string'),
    )
  } catch {
    return new Map()
  }
}

export function savePhotos(photos: Map<string, string>): void {
  localStorage.setItem(K_PHOTOS, JSON.stringify(Object.fromEntries(photos)))
}

function isViaPoint(x: unknown): x is ViaPoint {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return (
    typeof o.afterStopIndex === 'number' &&
    typeof o.lat === 'number' &&
    typeof o.lng === 'number'
  )
}

function isPoiFeature(x: unknown): x is PoiFeature {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (o.type !== 'Feature') return false
  const g = o.geometry as Record<string, unknown> | undefined
  if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) return false
  const p = o.properties as Record<string, unknown> | undefined
  if (!p || typeof p.id !== 'string' || typeof p.name !== 'string') return false
  return typeof p.category === 'string'
}
