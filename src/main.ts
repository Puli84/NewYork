import './style.css'
import L from 'leaflet'
import 'leaflet.markercluster'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'
import { registerSW } from 'virtual:pwa-register'
import { haversineMeters, sortIdsByNearestNeighbor, fetchOsrmWalkRoute, type OsrmLeg } from './geo.ts'
import {
  loadRoutes,
  loadUserPois,
  loadVisited,
  loadPhotos,
  saveRoutes,
  saveUserPois,
  saveVisited,
  savePhotos,
} from './storage.ts'
import {
  inferZoneId,
  NYC_ZONES,
  zoneBoundsLeaflet,
  zoneLabel,
} from './nyc-zones.ts'
import type { PoiFeature, RouteDay, RoutesPayload, ViaPoint } from './types.ts'
import { isFirebaseConfigured } from './firebase-config.ts'
import {
  getOrCreateUserId,
  publishPosition,
  watchTravelers,
  removeMe,
  saveSharedRoutes,
  watchSharedRoutes,
  type TravelerData,
} from './realtime.ts'

registerSW({ immediate: true })

delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: string })._getIconUrl
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
})

const CAT_ORDER = [
  'museum',
  'park',
  'viewpoint',
  'historic',
  'food',
  'neighborhood',
  'bridge',
  'other',
] as const

const CAT_LABEL: Record<string, string> = {
  museum: 'Museo',
  park: 'Parque',
  viewpoint: 'Mirador',
  historic: 'Histórico',
  food: 'Comida',
  neighborhood: 'Barrio',
  bridge: 'Puente',
  other: 'Otro',
}

const CAT_COLOR: Record<string, string> = {
  museum: '#a855f7',
  park: '#34d399',
  viewpoint: '#fb923c',
  historic: '#f87171',
  food: '#fbbf24',
  neighborhood: '#38bdf8',
  bridge: '#2dd4bf',
  other: '#94a3b8',
}

const CAT_EMOJI: Record<string, string> = {
  museum: '🖼️',
  park: '🌳',
  viewpoint: '🔭',
  historic: '📜',
  food: '🍽️',
  neighborhood: '🏙️',
  bridge: '🌉',
  other: '📍',
}
const DEDUP_METERS = 50
const NYC_CENTER: L.LatLngExpression = [40.748817, -73.985428]

const HOME_BASE = {
  label: 'Times Square (hotel)',
  lat: 40.7580,
  lng: -73.9855,
} as const

/** Área metro: NYC, Brooklyn, Queens/Bronx cercanos y NJ al otro lado del Hudson (no mundo completo). */
const METRO_BOUNDS = L.latLngBounds(
  [40.43, -74.45],
  [40.97, -73.52],
)

let seedFeatures: PoiFeature[] = []
let userFeatures: PoiFeature[] = loadUserPois()
let visited = loadVisited()
let photoOverrides = loadPhotos()
let routesPayload = loadRoutes()
let activeDayId = routesPayload.days[0]?.id ?? 'day-1'

let userLatLng: L.LatLng | null = null
let watchId: number | null = null

let addMode = false
let routeEditMode = false
let routeFreeMode = false
let activeTab: 'map' | 'food' = 'map'

const coordById = new Map<string, [number, number]>()
const markerById = new Map<string, L.Marker>()

// Colores para los compañeros (el usuario propio siempre usa el azul del userDot)
const TRAVELER_COLORS = ['#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#f97316', '#06b6d4']

function colorFromId(id: string): string {
  let h = 0
  for (const c of id) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0
  return TRAVELER_COLORS[Math.abs(h) % TRAVELER_COLORS.length]
}

function getTravelerName(): string {
  const key = 'nyc-traveler-name'
  let name = localStorage.getItem(key)
  if (!name) {
    name = (prompt('¿Cómo te llamas? Aparecerá en el mapa para los demás:') ?? '').trim()
    if (!name) name = 'Viajero'
    localStorage.setItem(key, name)
  }
  return name
}

let sharingActive = false
let stopWatchTravelers: (() => void) | null = null
const travelerMarkers = new Map<string, L.Marker>()

let map: L.Map
let cluster: L.MarkerClusterGroup
let routeLine: L.Polyline | null = null
let routeViaMarkers: L.Marker[] = []
let routeArrowMarkers: L.Marker[] = []
let routeFetchAbort: AbortController | null = null
let routeSegmentTimes: OsrmLeg[] = []  // un elemento por par de paradas consecutivas
let userDot: L.CircleMarker | null = null
let userAcc: L.Circle | null = null
/** Capas grises fuera de la zona seleccionada (debajo de rutas y marcadores). */
let zoneDimLayerGroup: L.LayerGroup | null = null

function boundsIntersect(
  a: L.LatLngBounds,
  b: L.LatLngBounds,
): L.LatLngBounds | null {
  const south = Math.max(a.getSouth(), b.getSouth())
  const north = Math.min(a.getNorth(), b.getNorth())
  const west = Math.max(a.getWest(), b.getWest())
  const east = Math.min(a.getEast(), b.getEast())
  if (south >= north || west >= east) return null
  return L.latLngBounds(L.latLng(south, west), L.latLng(north, east))
}

/** Oscurece todo el mapa metro menos el rectángulo de la zona (cuatro bandas). */
function syncZoneDimOverlay(zoneId: string): void {
  if (!map || !zoneDimLayerGroup) return
  zoneDimLayerGroup.clearLayers()
  zoneDimLayerGroup.remove()
  if (!zoneId) return

  const corners = zoneBoundsLeaflet(zoneId)
  if (!corners) return
  const zoneB = L.latLngBounds(corners[0], corners[1])
  const sel = boundsIntersect(METRO_BOUNDS, zoneB)
  if (!sel) return

  const outer = METRO_BOUNDS
  const south = outer.getSouth()
  const north = outer.getNorth()
  const west = outer.getWest()
  const east = outer.getEast()
  const selS = sel.getSouth()
  const selN = sel.getNorth()
  const selW = sel.getWest()
  const selE = sel.getEast()

  const dimOpts: L.PathOptions = {
    stroke: false,
    fillColor: '#070b12',
    fillOpacity: 0.58,
    interactive: false,
    pane: 'zoneDim',
  }

  if (selS > south) {
    zoneDimLayerGroup.addLayer(
      L.rectangle(L.latLngBounds(L.latLng(south, west), L.latLng(selS, east)), dimOpts),
    )
  }
  if (selN < north) {
    zoneDimLayerGroup.addLayer(
      L.rectangle(L.latLngBounds(L.latLng(selN, west), L.latLng(north, east)), dimOpts),
    )
  }
  if (selW > west) {
    zoneDimLayerGroup.addLayer(
      L.rectangle(L.latLngBounds(L.latLng(selS, west), L.latLng(selN, selW)), dimOpts),
    )
  }
  if (selE < east) {
    zoneDimLayerGroup.addLayer(
      L.rectangle(L.latLngBounds(L.latLng(selS, selE), L.latLng(selN, east)), dimOpts),
    )
  }

  zoneDimLayerGroup.addTo(map)
}

function ll(f: PoiFeature): L.LatLng {
  const [lng, lat] = f.geometry.coordinates
  return L.latLng(lat, lng)
}

function coordTuple(f: PoiFeature): [number, number] {
  const [lng, lat] = f.geometry.coordinates
  return [lat, lng]
}

function allFeatures(): PoiFeature[] {
  return [...seedFeatures, ...userFeatures]
}

function fillCategorySelects(): void {
  const filterSel = document.querySelector<HTMLSelectElement>('#filter-category')!
  const addSel = document.querySelector<HTMLSelectElement>('#add-category')!
  filterSel.innerHTML =
    '<option value="">Todas</option>' +
    CAT_ORDER.map(
      (c) => `<option value="${c}">${CAT_LABEL[c] ?? c}</option>`,
    ).join('')
  addSel.innerHTML = CAT_ORDER.map(
    (c) => `<option value="${c}">${CAT_LABEL[c] ?? c}</option>`,
  ).join('')
}

function persistVisited(): void {
  saveVisited(visited)
}

function persistUsers(): void {
  saveUserPois(userFeatures)
}

function persistRoutes(): void {
  saveRoutes(routesPayload)
  if (isFirebaseConfigured()) void saveSharedRoutes(routesPayload)
}

function currentDay(): RouteDay | undefined {
  return routesPayload.days.find((d) => d.id === activeDayId)
}

function rebuildCoordIndex(): void {
  coordById.clear()
  for (const f of allFeatures()) {
    const [lng, lat] = f.geometry.coordinates
    coordById.set(f.properties.id, [lat, lng])
  }
}

function normalizeForSearch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function searchQueryRaw(): string {
  return document.querySelector<HTMLInputElement>('#search-poi')?.value.trim() ?? ''
}

function matchesSearch(f: PoiFeature, rawQuery: string): boolean {
  const q = normalizeForSearch(rawQuery)
  if (!q) return true
  const name = normalizeForSearch(f.properties.name)
  if (name.includes(q)) return true
  const catLabel = normalizeForSearch(
    CAT_LABEL[f.properties.category] ?? f.properties.category,
  )
  if (catLabel.includes(q)) return true
  const catKey = normalizeForSearch(f.properties.category)
  if (catKey.includes(q)) return true
  const [lng, lat] = f.geometry.coordinates
  const zoneTxt = normalizeForSearch(zoneLabel(inferZoneId(lat, lng)))
  return zoneTxt.includes(q)
}

/** Menor = mejor coincidencia para ordenar lista al buscar. */
function searchRank(f: PoiFeature, q: string): number {
  const name = normalizeForSearch(f.properties.name)
  if (name.startsWith(q)) return 0
  const idx = name.indexOf(q)
  if (idx >= 0) return 1 + idx
  const catLabel = normalizeForSearch(
    CAT_LABEL[f.properties.category] ?? f.properties.category,
  )
  if (catLabel.includes(q) || normalizeForSearch(f.properties.category).includes(q))
    return 400
  const [lng, lat] = f.geometry.coordinates
  const zoneTxt = normalizeForSearch(zoneLabel(inferZoneId(lat, lng)))
  if (zoneTxt.includes(q)) return 320
  return 1000
}

function passesFilters(f: PoiFeature): boolean {
  const id = f.properties.id
  const cat = f.properties.category

  const qRaw = searchQueryRaw()
  if (qRaw && !matchesSearch(f, qRaw)) return false

  if (document.querySelector<HTMLInputElement>('#filter-pending')!.checked) {
    if (visited.has(id)) return false
  }

  const catSel = document.querySelector<HTMLSelectElement>('#filter-category')!.value
  if (catSel && cat !== catSel) return false

  const zoneSel = document.querySelector<HTMLSelectElement>('#filter-zone')!.value
  if (zoneSel) {
    const [lng, lat] = f.geometry.coordinates
    if (inferZoneId(lat, lng) !== zoneSel) return false
  }

  if (document.querySelector<HTMLInputElement>('#filter-radius')!.checked) {
    if (!userLatLng) return false
    const [lng, lat] = f.geometry.coordinates
    if (haversineMeters(userLatLng.lat, userLatLng.lng, lat, lng) > 500)
      return false
  }

  return true
}

function sortFeaturesForList(features: PoiFeature[]): PoiFeature[] {
  const copy = [...features]
  const here = userLatLng
  const qRaw = searchQueryRaw()
  const qNorm = qRaw ? normalizeForSearch(qRaw) : ''

  if (qNorm) {
    copy.sort((a, b) => {
      const ra = searchRank(a, qNorm)
      const rb = searchRank(b, qNorm)
      if (ra !== rb) return ra - rb
      if (here) {
        const [la, loa] = coordTuple(a)
        const [lb, lob] = coordTuple(b)
        const daa = haversineMeters(here.lat, here.lng, la, loa)
        const dab = haversineMeters(here.lat, here.lng, lb, lob)
        return daa - dab
      }
      return a.properties.name.localeCompare(b.properties.name, 'es')
    })
  } else if (here) {
    copy.sort((a, b) => {
      const [la, loa] = coordTuple(a)
      const [lb, lob] = coordTuple(b)
      const daa = haversineMeters(here.lat, here.lng, la, loa)
      const dab = haversineMeters(here.lat, here.lng, lb, lob)
      return daa - dab
    })
  } else {
    copy.sort((a, b) => a.properties.name.localeCompare(b.properties.name, 'es'))
  }
  return copy
}

function refreshSearchSummary(shownCount: number): void {
  const sum = document.querySelector<HTMLParagraphElement>('#search-summary')
  if (!sum) return
  const q = searchQueryRaw()
  const total = allFeatures().length
  if (!q) {
    sum.textContent = ''
    return
  }
  sum.textContent =
    shownCount === 0 ?
      'Sin coincidencias — prueba otras palabras o relaja filtros.'
    : `${shownCount} de ${total} lugares coinciden`
}

function formatSegmentTime(seg: OsrmLeg): string {
  const distM = Math.round(seg.distance)
  const distStr = distM >= 1000 ? `${(distM / 1000).toFixed(1)} km` : `${distM} m`
  // Velocidad peatonal: 5 km/h = 83 m/min. Usamos la distancia de OSRM
  // (la geometría es correcta aunque el servidor use perfil driving).
  const walkMin = Math.max(1, Math.round(distM / 83))
  let html = `<span class="rt-walk">🚶 ${walkMin} min</span><span class="rt-dist">${distStr}</span>`
  if (walkMin > 15 || distM > 1200) {
    // Metro: velocidad media NYC ~27 km/h + 5 min de andén/espera
    const metroMin = Math.max(3, Math.round(distM / 450 + 5))
    html += `<span class="rt-metro">🚇 ~${metroMin} min</span>`
  }
  return html
}

function rebuildSidebarList(): void {
  const el = document.querySelector<HTMLDivElement>('#poi-list')!
  const filtered = allFeatures().filter(passesFilters)
  const sorted = sortFeaturesForList(filtered)

  refreshSearchSummary(sorted.length)

  if (sorted.length === 0) {
    el.innerHTML =
      '<p class="poi-empty">Nada que mostrar con estos criterios.</p>'
    return
  }

  el.innerHTML = sorted
    .map((f) => {
      const id = f.properties.id
      const v = visited.has(id)
      const dist =
        userLatLng ?
          `${Math.round(
            haversineMeters(
              userLatLng.lat,
              userLatLng.lng,
              coordTuple(f)[0],
              coordTuple(f)[1],
            ),
          )} m · `
        : ''
      const tag = f.properties.user ? '<span class="tag">tuyo</span>' : ''
      const [lng, lat] = f.geometry.coordinates
      const zLbl = zoneLabel(inferZoneId(lat, lng))
      return `<button type="button" class="poi-item${v ? ' visited' : ''}" data-id="${id}">
        <span class="poi-title">${escapeHtml(f.properties.name)}</span>
        <span class="poi-meta"><span class="zone-chip">${escapeHtml(zLbl)}</span> · ${dist}${CAT_LABEL[f.properties.category] ?? f.properties.category} ${tag}</span>
      </button>`
    })
    .join('')

  el.querySelectorAll<HTMLButtonElement>('.poi-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id
      if (!id) return
      const m = markerById.get(id)
      const c = coordById.get(id)
      if (m) {
        cluster.zoomToShowLayer(m, () => {
          m.openPopup()
        })
      } else if (c) {
        map.setView([c[0], c[1]], 16)
      }
    })
  })
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function fillZoneSelect(): void {
  const sel = document.querySelector<HTMLSelectElement>('#filter-zone')
  if (!sel) return
  const sorted = [...NYC_ZONES].sort((a, b) =>
    a.label.localeCompare(b.label, 'es'),
  )
  sel.innerHTML =
    '<option value="">Todas las zonas</option>' +
    sorted
      .map((z) => `<option value="${z.id}">${escapeHtml(z.label)}</option>`)
      .join('')
}

function getPhoto(f: PoiFeature): string | undefined {
  return photoOverrides.get(f.properties.id) ?? f.properties.photo
}

function stickerIconFor(f: PoiFeature): L.DivIcon {
  const cat = f.properties.category
  const ring = CAT_COLOR[cat] ?? CAT_COLOR.other!
  const isV = visited.has(f.properties.id)
  const isU = !!f.properties.user
  const photo = getPhoto(f)

  const inner = photo
    ? ''
    : `<span class="map-sticker__emoji">${CAT_EMOJI[cat] ?? CAT_EMOJI.other}</span>`

  const classes = [
    'map-sticker',
    photo ? 'map-sticker--photo' : '',
    isV ? 'map-sticker--visited' : '',
    isU ? 'map-sticker--user' : '',
  ].filter(Boolean).join(' ')

  const bgStyle = photo ? `background-image:url('${escapeHtml(photo)}');` : ''

  const html = `<div class="${classes}" style="--sticker-ring:${ring};${bgStyle}" role="img" aria-label="${escapeHtml(f.properties.name)}">${inner}</div>`

  const w = photo ? 60 : 48
  const h = photo ? 68 : 54

  return L.divIcon({
    className: 'map-sticker-shell',
    html,
    iconSize: [w, h],
    iconAnchor: [w / 2, h - 4],
    popupAnchor: [0, -(h - 8)],
  })
}

function syncStickerTier(): void {
  if (!map) return
  const z = map.getZoom()
  const tier = z >= 16 ? 'near' : z >= 13 ? 'mid' : 'far'
  map.getContainer().dataset.stickerTier = tier
}

function openVisitToggle(id: string, next: boolean): void {
  if (next) visited.add(id)
  else visited.delete(id)
  persistVisited()
  rebuildMarkers()
  rebuildSidebarList()
}

function addStopToActiveRoute(id: string): void {
  const day = currentDay()
  if (!day) return
  if (!coordById.has(id)) return
  if (!day.stopIds.includes(id)) {
    day.stopIds.push(id)
    persistRoutes()
    rebuildRouteUi()
    rebuildRouteLine()
  }
}

function bindPopup(cm: L.Marker, f: PoiFeature): void {
  const id = f.properties.id
  const wrap = document.createElement('div')
  wrap.className = 'popup-inner'
  const [lng, lat] = f.geometry.coordinates
  const zLbl = zoneLabel(inferZoneId(lat, lng))
  const notes =
    f.properties.notes ?
      `<p class="popup-notes">${escapeHtml(f.properties.notes)}</p>`
    : ''

  const hasPhoto = !!getPhoto(f)
  wrap.innerHTML = `
    <strong>${escapeHtml(f.properties.name)}</strong>
    <div class="popup-tags"><span class="popup-zone">${escapeHtml(zLbl)}</span> · ${CAT_LABEL[f.properties.category] ?? f.properties.category}${f.properties.user ? ' · <span class="tag">tuyo</span>' : ''}</div>
    ${notes}
    <label class="popup-row"><input type="checkbox" class="chk-visit" ${visited.has(id) ? 'checked' : ''}/> Visitado</label>
    <button type="button" class="btn small wide btn-route">Añadir a ruta activa</button>
    <button type="button" class="btn small wide btn-photo">${hasPhoto ? '📷 Cambiar foto' : '📷 Añadir foto'}</button>
  `

  wrap.querySelector<HTMLInputElement>('.chk-visit')!.addEventListener(
    'change',
    (ev) => {
      openVisitToggle(id, (ev.target as HTMLInputElement).checked)
    },
  )

  wrap.querySelector<HTMLButtonElement>('.btn-route')!.addEventListener(
    'click',
    () => addStopToActiveRoute(id),
  )

  wrap.querySelector<HTMLButtonElement>('.btn-photo')!.addEventListener('click', () => {
    const current = getPhoto(f) ?? ''
    const url = prompt(
      `URL de la foto para "${f.properties.name}"\n(deja vacío para quitar):`,
      current,
    )
    if (url === null) return  // cancelado
    const trimmed = url.trim()
    if (trimmed) photoOverrides.set(id, trimmed)
    else photoOverrides.delete(id)
    savePhotos(photoOverrides)
    cm.closePopup()
    rebuildMarkers()
    rebuildSidebarList()
  })

  cm.bindPopup(wrap)
}

function rebuildMarkers(): void {
  cluster.clearLayers()
  markerById.clear()

  for (const f of allFeatures()) {
    if (!passesFilters(f)) continue
    const cm = L.marker(ll(f), {
      icon: stickerIconFor(f),
      interactive: true,
    })
    bindPopup(cm, f)
    markerById.set(f.properties.id, cm)
    cluster.addLayer(cm)
  }
}

function rebuildRouteUi(): void {
  const daySel = document.querySelector<HTMLSelectElement>('#route-day')!
  daySel.innerHTML = routesPayload.days
    .map(
      (d) =>
        `<option value="${d.id}" ${d.id === activeDayId ? 'selected' : ''}>${escapeHtml(d.label)} (${d.stopIds.length})</option>`,
    )
    .join('')

  const ul = document.querySelector<HTMLUListElement>('#route-stops')!
  const day = currentDay()
  ul.innerHTML =
    day ?
      day.stopIds
        .flatMap((id, i) => {
          const f = allFeatures().find((x) => x.properties.id === id)
          const title = f?.properties.name ?? '(punto desconocido — importar datos)'
          const stopHtml = `<li draggable="true" data-id="${id}" class="route-li">
            <span class="drag-h">⋮⋮</span>
            <span class="route-title">${escapeHtml(title)}</span>
            <button type="button" class="btn-icon rm" draggable="false" data-rm="${id}" aria-label="Quitar">✕</button>
          </li>`
          if (i < day.stopIds.length - 1) {
            const seg = routeSegmentTimes[i]
            const timeHtml = seg ?
              `<li class="route-time-row" aria-hidden="true">${formatSegmentTime(seg)}</li>`
            : `<li class="route-time-row route-time-row--pending" aria-hidden="true"><span class="rt-walk rt-loading">· · ·</span></li>`
            return [stopHtml, timeHtml]
          }
          return [stopHtml]
        })
        .join('')
    : ''

  ul.querySelectorAll<HTMLButtonElement>('.rm').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rid = btn.dataset.rm
      const d = currentDay()
      if (!d || !rid) return
      d.stopIds = d.stopIds.filter((x) => x !== rid)
      d.viaPoints = []  // los índices cambian al quitar una parada
      persistRoutes()
      rebuildRouteUi()
      void rebuildRouteLine()
    })
  })
}

function getDragAfterElement(
  container: HTMLUListElement,
  y: number,
): HTMLElement | undefined {
  const els = [
    ...container.querySelectorAll<HTMLElement>('.route-li:not(.dragging)'),
  ]
  let closest: { offset: number; el?: HTMLElement } = {
    offset: Number.NEGATIVE_INFINITY,
  }
  for (const el of els) {
    const box = el.getBoundingClientRect()
    const offset = y - box.top - box.height / 2
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, el }
    }
  }
  return closest.el
}

/** Devuelve el ángulo en grados (0=norte, 90=este) entre dos puntos lat/lng. */
function bearingDeg(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLng = toRad(bLng - aLng)
  const la1 = toRad(aLat)
  const la2 = toRad(bLat)
  const x = Math.sin(dLng) * Math.cos(la2)
  const y = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng)
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360
}

/**
 * Coloca flechas SVG a lo largo de una polyline para indicar la dirección.
 * Se sitúan en el punto medio de cada segmento de la polyline.
 */
function placeRouteArrows(latlngs: L.LatLngExpression[]): void {
  routeArrowMarkers.forEach((m) => map.removeLayer(m))
  routeArrowMarkers = []

  const pts = latlngs.map((ll) => (Array.isArray(ll) ? L.latLng(ll[0] as number, ll[1] as number) : ll as L.LatLng))
  // Colocar una flecha cada ~30 puntos para no saturar
  const step = Math.max(1, Math.floor(pts.length / Math.max(1, Math.floor(pts.length / 30))))

  for (let i = step; i < pts.length - 1; i += step) {
    const a = pts[i - 1]
    const b = pts[i]
    const midLat = (a.lat + b.lat) / 2
    const midLng = (a.lng + b.lng) / 2
    const angle = bearingDeg(a.lat, a.lng, b.lat, b.lng)

    const icon = L.divIcon({
      className: 'route-arrow-shell',
      html: `<div class="route-arrow" style="transform:rotate(${angle}deg)">▲</div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    })
    const m = L.marker([midLat, midLng], { icon, interactive: false, zIndexOffset: 300 }).addTo(map)
    routeArrowMarkers.push(m)
  }
}

/** Construye la lista ordenada de waypoints (stops + via points intercalados). */
function buildRouteWaypoints(day: RouteDay): Array<[number, number]> {
  const vias = [...(day.viaPoints ?? [])].sort((a, b) => a.afterStopIndex - b.afterStopIndex)
  const pts: Array<[number, number]> = []
  for (let i = 0; i < day.stopIds.length; i++) {
    const c = coordById.get(day.stopIds[i])
    if (c) pts.push([c[0], c[1]])
    for (const v of vias.filter((v) => v.afterStopIndex === i)) {
      pts.push([v.lat, v.lng])
    }
  }
  return pts
}

/** Distancia de un punto P al segmento AB (en metros, usando proyección). */
function pointToSegDist(
  pLat: number, pLng: number,
  aLat: number, aLng: number,
  bLat: number, bLng: number,
): number {
  const dx = bLng - aLng
  const dy = bLat - aLat
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return haversineMeters(pLat, pLng, aLat, aLng)
  const t = Math.max(0, Math.min(1, ((pLng - aLng) * dx + (pLat - aLat) * dy) / lenSq))
  return haversineMeters(pLat, pLng, aLat + t * dy, aLng + t * dx)
}

/** Devuelve el índice i tal que el punto cae en el segmento (stopIds[i] → stopIds[i+1]). */
function nearestStopSegment(lat: number, lng: number, day: RouteDay): number {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i + 1 < day.stopIds.length; i++) {
    const a = coordById.get(day.stopIds[i])
    const b = coordById.get(day.stopIds[i + 1])
    if (!a || !b) continue
    const d = pointToSegDist(lat, lng, a[0], a[1], b[0], b[1])
    if (d < bestDist) { bestDist = d; best = i }
  }
  return best
}

async function rebuildRouteLine(): Promise<void> {
  // Cancela cualquier petición OSRM anterior en vuelo
  routeFetchAbort?.abort()
  routeFetchAbort = new AbortController()
  const { signal } = routeFetchAbort

  if (routeLine) { map.removeLayer(routeLine); routeLine = null }
  routeViaMarkers.forEach((m) => map.removeLayer(m))
  routeArrowMarkers.forEach((m) => map.removeLayer(m))
  routeViaMarkers = []
  routeArrowMarkers = []
  routeSegmentTimes = []

  const show = document.querySelector<HTMLInputElement>('#chk-show-route')!.checked
  if (!show) { rebuildRouteUi(); return }

  const day = currentDay()
  if (!day || day.stopIds.length < 2) { rebuildRouteUi(); return }

  // Waypoints de paradas + via points (sin hotel)
  const waypoints = buildRouteWaypoints(day)
  if (waypoints.length < 2) { rebuildRouteUi(); return }

  // Siempre arranca desde el hotel base
  const drawWaypoints: Array<[number, number]> = [[HOME_BASE.lat, HOME_BASE.lng], ...waypoints]

  rebuildRouteUi()  // muestra "··· calculando" entre paradas mientras espera

  let latlngs: L.LatLngExpression[]

  if (routeFreeMode) {
    // Modo libre: línea recta entre waypoints (hotel incluido), sin OSRM
    latlngs = drawWaypoints.map(([lat, lng]) => [lat, lng])
    // Calcular distancias solo entre paradas (no hotel→stop[0])
    const viasBySegment = new Map<number, number>()
    for (const v of day.viaPoints ?? []) {
      viasBySegment.set(v.afterStopIndex, (viasBySegment.get(v.afterStopIndex) ?? 0) + 1)
    }
    let wIdx = 0
    for (let i = 0; i + 1 < day.stopIds.length; i++) {
      const count = (viasBySegment.get(i) ?? 0) + 1
      let dist = 0
      for (let j = 0; j < count; j++) {
        const a = waypoints[wIdx + j]
        const b = waypoints[wIdx + j + 1]
        if (a && b) dist += haversineMeters(a[0], a[1], b[0], b[1])
      }
      wIdx += count
      routeSegmentTimes.push({ duration: 0, distance: dist })
    }
    rebuildRouteUi()
  } else {
    const osrmResult = await fetchOsrmWalkRoute(drawWaypoints, signal)
    if (signal.aborted) return  // resultado obsoleto, descartar

    if (osrmResult) {
      const viasBySegment = new Map<number, number>()
      for (const v of day.viaPoints ?? []) {
        viasBySegment.set(v.afterStopIndex, (viasBySegment.get(v.afterStopIndex) ?? 0) + 1)
      }
      // La leg 0 es hotel→primer stop: saltarla para los tiempos del sidebar
      let legIdx = 1
      for (let i = 0; i + 1 < day.stopIds.length; i++) {
        const legsForSegment = (viasBySegment.get(i) ?? 0) + 1
        let totalDuration = 0
        let totalDistance = 0
        for (let j = 0; j < legsForSegment && legIdx < osrmResult.legs.length; j++, legIdx++) {
          totalDuration += osrmResult.legs[legIdx].duration
          totalDistance += osrmResult.legs[legIdx].distance
        }
        routeSegmentTimes.push({ duration: totalDuration, distance: totalDistance })
      }
      rebuildRouteUi()
    }
    latlngs = (osrmResult?.coords ?? drawWaypoints).map(([lat, lng]) => [lat, lng])
  }

  routeLine = L.polyline(latlngs, {
    color: '#ef4444',
    weight: 5,
    opacity: 0.9,
    dashArray: routeFreeMode ? '10 5' : undefined,
  }).addTo(map)

  placeRouteArrows(latlngs)

  // Clic en la línea → añadir via point en ese punto
  routeLine.on('click', (ev: L.LeafletMouseEvent) => {
    L.DomEvent.stopPropagation(ev)
    const d = currentDay()
    if (!d) return
    if (!d.viaPoints) d.viaPoints = []
    const newVia: ViaPoint = {
      afterStopIndex: nearestStopSegment(ev.latlng.lat, ev.latlng.lng, d),
      lat: ev.latlng.lat,
      lng: ev.latlng.lng,
    }
    d.viaPoints.push(newVia)
    persistRoutes()
    void rebuildRouteLine()
  })

  // Marcadores arrastrables para cada via point
  ;(day.viaPoints ?? []).forEach((via, vi) => {
    const icon = L.divIcon({
      className: 'via-marker-shell',
      html: '<div class="via-handle"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    })
    const vm = L.marker([via.lat, via.lng], { icon, draggable: true, zIndexOffset: 500 }).addTo(map)
    vm.bindTooltip('Arrastra para mover · Doble clic para eliminar', {
      direction: 'top',
      offset: [0, -10],
    })

    vm.on('dragend', () => {
      const d = currentDay()
      if (!d?.viaPoints?.[vi]) return
      const p = vm.getLatLng()
      d.viaPoints[vi] = { ...d.viaPoints[vi], lat: p.lat, lng: p.lng }
      persistRoutes()
      void rebuildRouteLine()
    })

    vm.on('dblclick', (ev: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(ev)
      const d = currentDay()
      if (!d?.viaPoints) return
      d.viaPoints.splice(vi, 1)
      persistRoutes()
      void rebuildRouteLine()
    })

    routeViaMarkers.push(vm)
  })
}

function closestDuplicateMeters(lat: number, lng: number): number | null {
  let best: number | null = null
  for (const f of allFeatures()) {
    const [flng, flat] = f.geometry.coordinates
    const d = haversineMeters(lat, lng, flat, flng)
    if (best === null || d < best) best = d
  }
  return best
}

function startRouteEditMode(): void {
  if (addMode) stopAddMode()
  routeEditMode = true
  document.querySelector<HTMLButtonElement>('#btn-route-edit')!.classList.add('active')
  document.querySelector<HTMLElement>('#map')!.classList.add('add-cursor')
  document.querySelector<HTMLParagraphElement>('#gps-hint')!.textContent =
    'Modo editar ruta activo: haz clic en el mapa para añadir un desvío. Esc para salir.'
}

function stopRouteEditMode(): void {
  routeEditMode = false
  document.querySelector<HTMLButtonElement>('#btn-route-edit')!.classList.remove('active')
  document.querySelector<HTMLElement>('#map')!.classList.remove('add-cursor')
  document.querySelector<HTMLParagraphElement>('#gps-hint')!.textContent = ''
}

function startAddMode(): void {
  addMode = true
  document.querySelector<HTMLButtonElement>('#btn-add-toggle')!.classList.add('active')
  document.querySelector<HTMLElement>('#map')!.classList.add('add-cursor')
  document.querySelector<HTMLParagraphElement>('#gps-hint')!.textContent =
    'Modo añadir: haz clic en el mapa para colocar un punto.'
}

function stopAddMode(): void {
  addMode = false
  document.querySelector<HTMLButtonElement>('#btn-add-toggle')!.classList.remove('active')
  document.querySelector<HTMLElement>('#map')!.classList.remove('add-cursor')
}

function openAddDialog(latlng: L.LatLng): void {
  const form = document.querySelector<HTMLFormElement>('#form-add')!
  form.reset()
  ;(form.elements.namedItem('lat') as HTMLInputElement).value = String(
    latlng.lat,
  )
  ;(form.elements.namedItem('lng') as HTMLInputElement).value = String(
    latlng.lng,
  )
  document.querySelector<HTMLDialogElement>('#dlg-add')!.showModal()
}

function exportPayload(): {
  version: 1
  visited: string[]
  userPois: PoiFeature[]
  routes: RoutesPayload
} {
  return {
    version: 1,
    visited: [...visited],
    userPois: userFeatures,
    routes: { days: routesPayload.days },
  }
}

function rebuildTravelersList(travelers: Map<string, TravelerData>, myId: string): void {
  const ul = document.querySelector<HTMLUListElement>('#travelers-list')!
  const hint = document.querySelector<HTMLParagraphElement>('#sharing-hint')!
  const others = [...travelers.entries()].filter(([id]) => id !== myId)

  if (!sharingActive) {
    hint.textContent = 'Activa para que los demás te vean en el mapa.'
    ul.innerHTML = ''
    return
  }

  const myName = getTravelerName()
  const myColor = colorFromId(myId)
  hint.textContent = ''

  const myItem = `<li class="traveler-item traveler-item--me">
    <span class="traveler-dot-inline" style="background:${myColor}"></span>
    <span class="traveler-item-name">${escapeHtml(myName)} <span class="traveler-you">(tú)</span></span>
  </li>`

  if (others.length === 0) {
    ul.innerHTML = myItem + '<li class="traveler-item traveler-item--empty">Nadie más conectado aún</li>'
    return
  }

  ul.innerHTML = myItem + others
    .map(([, t]) => `<li class="traveler-item">
      <span class="traveler-dot-inline" style="background:${t.color}"></span>
      <span class="traveler-item-name">${escapeHtml(t.name)}</span>
    </li>`)
    .join('')
}

function updateTravelerMarkers(travelers: Map<string, TravelerData>): void {
  const myId = getOrCreateUserId()

  // Elimina marcadores de viajeros que ya no están
  for (const [id, marker] of travelerMarkers) {
    if (!travelers.has(id)) {
      map.removeLayer(marker)
      travelerMarkers.delete(id)
    }
  }

  // Crea o actualiza marcadores de los demás
  for (const [id, t] of travelers) {
    if (id === myId) continue  // el propio se muestra con el punto azul existente

    const icon = L.divIcon({
      className: 'traveler-marker-shell',
      html: `<div class="traveler-marker" style="--tcolor:${t.color}">
        <div class="traveler-pulse"></div>
        <div class="traveler-center"></div>
        <span class="traveler-label">${escapeHtml(t.name)}</span>
      </div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    })

    if (travelerMarkers.has(id)) {
      travelerMarkers.get(id)!.setLatLng([t.lat, t.lng])
      travelerMarkers.get(id)!.setIcon(icon)
    } else {
      const m = L.marker([t.lat, t.lng], { icon, zIndexOffset: 900, interactive: false }).addTo(map)
      travelerMarkers.set(id, m)
    }
  }

  rebuildTravelersList(travelers, myId)
}

async function startSharing(): Promise<void> {
  if (!isFirebaseConfigured()) {
    alert('Rellena src/firebase-config.ts con los datos de tu proyecto Firebase para usar esta función.')
    document.querySelector<HTMLInputElement>('#chk-share-location')!.checked = false
    return
  }
  sharingActive = true
  const userId = getOrCreateUserId()
  const name = getTravelerName()
  const color = colorFromId(userId)

  if (userLatLng) {
    await publishPosition(userId, name, userLatLng.lat, userLatLng.lng, color)
  }

  stopWatchTravelers = watchTravelers(updateTravelerMarkers)
}

async function stopSharing(): Promise<void> {
  sharingActive = false
  stopWatchTravelers?.()
  stopWatchTravelers = null

  for (const m of travelerMarkers.values()) map.removeLayer(m)
  travelerMarkers.clear()

  const userId = getOrCreateUserId()
  await removeMe(userId)

  rebuildTravelersList(new Map(), userId)
}

/** Distancia mínima de un punto a cualquier parada del día activo. */
function nearestRouteDistance(lat: number, lng: number): number {
  const day = currentDay()
  if (!day || day.stopIds.length === 0) return Infinity
  let best = Infinity
  for (const id of day.stopIds) {
    const c = coordById.get(id)
    if (!c) continue
    const d = haversineMeters(lat, lng, c[0], c[1])
    if (d < best) best = d
  }
  return best
}

function rebuildFoodTab(): void {
  const el = document.querySelector<HTMLDivElement>('#food-list')!
  const subtitle = document.querySelector<HTMLParagraphElement>('#food-subtitle')!
  const nearOnly = document.querySelector<HTMLInputElement>('#food-near-only')!.checked
  const NEAR_METERS = 800

  const day = currentDay()
  const hasStops = !!(day && day.stopIds.length > 0)

  let foodPois = allFeatures().filter((f) => f.properties.category === 'food')

  if (nearOnly && hasStops) {
    foodPois = foodPois.filter((f) => {
      const [lng, lat] = f.geometry.coordinates
      return nearestRouteDistance(lat, lng) <= NEAR_METERS
    })
  }

  foodPois.sort((a, b) => {
    if (hasStops) {
      const [alng, alat] = a.geometry.coordinates
      const [blng, blat] = b.geometry.coordinates
      return nearestRouteDistance(alat, alng) - nearestRouteDistance(blat, blng)
    }
    return a.properties.name.localeCompare(b.properties.name, 'es')
  })

  if (hasStops) {
    subtitle.textContent = `${foodPois.length} sitios · ordenados por cercanía a tus paradas de hoy`
  } else {
    subtitle.textContent = `${foodPois.length} sitios · añade paradas al día activo para ordenar por cercanía`
  }

  if (foodPois.length === 0) {
    el.innerHTML = '<p class="poi-empty">Ningún sitio de comida cerca de tus paradas.</p>'
    return
  }

  el.innerHTML = foodPois
    .map((f) => {
      const id = f.properties.id
      const [lng, lat] = f.geometry.coordinates
      const v = visited.has(id)
      const zLbl = zoneLabel(inferZoneId(lat, lng))
      const dist = hasStops ? nearestRouteDistance(lat, lng) : Infinity
      const distStr = dist !== Infinity ? `${Math.round(dist)} m · ` : ''
      const notes = f.properties.notes ? ` · ${escapeHtml(f.properties.notes)}` : ''
      return `<button type="button" class="poi-item${v ? ' visited' : ''}" data-id="${id}">
        <span class="poi-title">${escapeHtml(f.properties.name)}</span>
        <span class="poi-meta"><span class="zone-chip">${escapeHtml(zLbl)}</span> · ${distStr}${v ? '✓ visitado' : 'pendiente'}${notes}</span>
      </button>`
    })
    .join('')

  el.querySelectorAll<HTMLButtonElement>('.poi-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id
      if (!id) return
      const m = markerById.get(id)
      const c = coordById.get(id)
      if (m) {
        cluster.zoomToShowLayer(m, () => m.openPopup())
      } else if (c) {
        map.setView([c[0], c[1]], 16)
      }
    })
  })
}

function switchTab(tab: 'map' | 'food'): void {
  activeTab = tab
  const tabMap = document.querySelector<HTMLDivElement>('#tab-map')!
  const tabFood = document.querySelector<HTMLDivElement>('#tab-food')!
  const btnMap = document.querySelector<HTMLButtonElement>('#btn-tab-map')!
  const btnFood = document.querySelector<HTMLButtonElement>('#btn-tab-food')!

  tabMap.hidden = tab !== 'map'
  tabFood.hidden = tab !== 'food'
  btnMap.classList.toggle('tab-btn--active', tab === 'map')
  btnFood.classList.toggle('tab-btn--active', tab === 'food')

  if (tab === 'food') rebuildFoodTab()
}

function wireUi(): void {
  // Sidebar deslizante en móvil
  const sidebarEl = document.querySelector<HTMLElement>('.sidebar')!
  const backdropEl = document.querySelector<HTMLElement>('#sidebar-backdrop')!
  const toggleBtn = document.querySelector<HTMLButtonElement>('#btn-sidebar-toggle')!

  function openSidebar(): void {
    sidebarEl.classList.add('sidebar--open')
    backdropEl.classList.add('sidebar-backdrop--visible')
    toggleBtn.textContent = '✕'
    toggleBtn.setAttribute('aria-label', 'Cerrar menú')
  }

  function closeSidebar(): void {
    sidebarEl.classList.remove('sidebar--open')
    backdropEl.classList.remove('sidebar-backdrop--visible')
    toggleBtn.textContent = '☰'
    toggleBtn.setAttribute('aria-label', 'Abrir menú')
  }

  toggleBtn.addEventListener('click', () => {
    sidebarEl.classList.contains('sidebar--open') ? closeSidebar() : openSidebar()
  })
  backdropEl.addEventListener('click', closeSidebar)

  // Cerrar sidebar al seleccionar un POI de la lista (para ver el mapa)
  document.querySelector<HTMLDivElement>('#poi-list')!.addEventListener('click', () => {
    if (window.innerWidth <= 840) closeSidebar()
  })
  document.querySelector<HTMLDivElement>('#food-list')!.addEventListener('click', () => {
    if (window.innerWidth <= 840) closeSidebar()
  })

  document.querySelector<HTMLButtonElement>('#btn-tab-map')!.addEventListener('click', () => switchTab('map'))
  document.querySelector<HTMLButtonElement>('#btn-tab-food')!.addEventListener('click', () => switchTab('food'))
  document.querySelector<HTMLInputElement>('#food-near-only')!.addEventListener('change', () => {
    if (activeTab === 'food') rebuildFoodTab()
  })

  document.querySelector<HTMLButtonElement>('#btn-locate')!.addEventListener(
    'click',
    () => {
      if (!navigator.geolocation) {
        document.querySelector<HTMLParagraphElement>('#gps-hint')!.textContent =
          'Tu navegador no permite geolocalización.'
        return
      }
      document.querySelector<HTMLParagraphElement>('#gps-hint')!.textContent =
        'Buscando GPS…'

      const ok = (pos: GeolocationPosition) => {
        const { latitude, longitude, accuracy } = pos.coords
        const latlng = L.latLng(latitude, longitude)
        userLatLng = latlng

        if (sharingActive) {
          const userId = getOrCreateUserId()
          void publishPosition(userId, getTravelerName(), latitude, longitude, colorFromId(userId))
        }

        if (!userDot) {
          userDot = L.circleMarker(latlng, {
            radius: 9,
            color: '#2980b9',
            fillColor: '#3498db',
            fillOpacity: 0.95,
            weight: 2,
          }).addTo(map)
        } else {
          userDot.setLatLng(latlng)
        }

        if (!userAcc) {
          userAcc = L.circle(latlng, {
            radius: accuracy,
            color: '#3498db',
            fillOpacity: 0.08,
            weight: 1,
          }).addTo(map)
        } else {
          userAcc.setLatLng(latlng)
          userAcc.setRadius(accuracy)
        }

        const isFirstFix = watchId === null
        if (isFirstFix) map.setView(latlng, 15)
        document.querySelector<HTMLParagraphElement>('#gps-hint')!.textContent =
          `GPS activo · precisión ~${Math.round(accuracy)} m`
        document.querySelector<HTMLButtonElement>('#btn-stop-gps')!.hidden =
          false

        rebuildSidebarList()

        if (watchId !== null) navigator.geolocation.clearWatch(watchId)
        watchId = navigator.geolocation.watchPosition(
          (p) => ok(p),
          (err) => {
            document.querySelector<HTMLParagraphElement>('#gps-hint')!.textContent =
              `GPS: ${err.message}`
          },
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
        )
      }

      navigator.geolocation.getCurrentPosition(ok, (err) => {
        document.querySelector<HTMLParagraphElement>('#gps-hint')!.textContent =
          `No se pudo obtener ubicación: ${err.message}. Usa HTTPS y permisos.`
      })
    },
  )

  document.querySelector<HTMLButtonElement>('#btn-stop-gps')!.addEventListener(
    'click',
    () => {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId)
        watchId = null
      }
      document.querySelector<HTMLParagraphElement>('#gps-hint')!.textContent =
        'GPS detenido.'
      document.querySelector<HTMLButtonElement>('#btn-stop-gps')!.hidden = true
    },
  )

  document.querySelector<HTMLButtonElement>('#btn-add-toggle')!.addEventListener(
    'click',
    () => {
      if (addMode) stopAddMode()
      else startAddMode()
    },
  )

  document.querySelector<HTMLButtonElement>('#btn-route-edit')!.addEventListener('click', () => {
    if (routeEditMode) stopRouteEditMode()
    else startRouteEditMode()
  })

  document.querySelector<HTMLInputElement>('#chk-route-free')!.addEventListener('change', (e) => {
    routeFreeMode = (e.target as HTMLInputElement).checked
    void rebuildRouteLine()
  })

  const searchInput = document.querySelector<HTMLInputElement>('#search-poi')!
  const runSearch = (): void => {
    rebuildMarkers()
    rebuildSidebarList()
  }
  searchInput.addEventListener('input', runSearch)
  searchInput.addEventListener('search', runSearch)
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return
    ev.preventDefault()
    document.querySelector<HTMLButtonElement>('#poi-list .poi-item')?.click()
  })

  for (const id of ['#filter-pending', '#filter-radius']) {
    document.querySelector<HTMLInputElement>(id)!.addEventListener(
      'change',
      () => {
        rebuildMarkers()
        rebuildSidebarList()
      },
    )
  }

  document.querySelector<HTMLSelectElement>('#filter-category')!.addEventListener(
    'change',
    () => {
      rebuildMarkers()
      rebuildSidebarList()
    },
  )

  document.querySelector<HTMLSelectElement>('#filter-zone')!.addEventListener(
    'change',
    () => {
      rebuildMarkers()
      rebuildSidebarList()
      const zid = document.querySelector<HTMLSelectElement>('#filter-zone')!.value
      syncZoneDimOverlay(zid)
      if (zid) {
        const b = zoneBoundsLeaflet(zid)
        if (b) map.fitBounds(b, { padding: [52, 52], maxZoom: 15, animate: true })
      }
    },
  )

  document.querySelector<HTMLSelectElement>('#route-day')!.addEventListener(
    'change',
    (e) => {
      activeDayId = (e.target as HTMLSelectElement).value
      rebuildRouteUi()
      void rebuildRouteLine()
      if (activeTab === 'food') rebuildFoodTab()
    },
  )

  document.querySelector<HTMLButtonElement>('#btn-day-rename')!.addEventListener('click', () => {
    const day = currentDay()
    if (!day) return
    const name = prompt('Nuevo nombre para este día:', day.label)?.trim()
    if (!name) return
    day.label = name
    persistRoutes()
    rebuildRouteUi()
  })

  document.querySelector<HTMLButtonElement>('#btn-day-up')!.addEventListener('click', () => {
    const idx = routesPayload.days.findIndex((d) => d.id === activeDayId)
    if (idx <= 0) return
    ;[routesPayload.days[idx - 1], routesPayload.days[idx]] = [routesPayload.days[idx], routesPayload.days[idx - 1]]
    persistRoutes()
    rebuildRouteUi()
    void rebuildRouteLine()
  })

  document.querySelector<HTMLButtonElement>('#btn-day-down')!.addEventListener('click', () => {
    const idx = routesPayload.days.findIndex((d) => d.id === activeDayId)
    if (idx < 0 || idx >= routesPayload.days.length - 1) return
    ;[routesPayload.days[idx], routesPayload.days[idx + 1]] = [routesPayload.days[idx + 1], routesPayload.days[idx]]
    persistRoutes()
    rebuildRouteUi()
    void rebuildRouteLine()
  })

  document.querySelector<HTMLButtonElement>('#btn-new-day')!.addEventListener(
    'click',
    () => {
      const n = routesPayload.days.length + 1
      const id = `day-${crypto.randomUUID()}`
      routesPayload.days.push({ id, label: `Día ${n}`, stopIds: [] })
      activeDayId = id
      persistRoutes()
      rebuildRouteUi()
      void rebuildRouteLine()
    },
  )

  document.querySelector<HTMLButtonElement>('#btn-del-day')!.addEventListener(
    'click',
    () => {
      if (routesPayload.days.length <= 1) {
        alert('Debe haber al menos un día.')
        return
      }
      const day = currentDay()
      if (!day) return
      if (!confirm(`¿Borrar "${day.label}" y todas sus paradas?`)) return
      const idx = routesPayload.days.findIndex((d) => d.id === activeDayId)
      routesPayload.days.splice(idx, 1)
      activeDayId = routesPayload.days[Math.max(0, idx - 1)].id
      persistRoutes()
      rebuildRouteUi()
      void rebuildRouteLine()
    },
  )

  document.querySelector<HTMLInputElement>('#chk-show-route')!.addEventListener(
    'change',
    () => void rebuildRouteLine(),
  )

  document.querySelector<HTMLButtonElement>('#btn-sort-nearest')!.addEventListener(
    'click',
    () => {
      const day = currentDay()
      if (!day || day.stopIds.length === 0) return

      let startLat: number
      let startLon: number
      if (userLatLng) {
        startLat = userLatLng.lat
        startLon = userLatLng.lng
      } else {
        // Sin GPS: partir desde el hotel base (Times Square)
        startLat = HOME_BASE.lat
        startLon = HOME_BASE.lng
      }

      const mapCoords = new Map<string, [number, number]>()
      for (const id of day.stopIds) {
        const cc = coordById.get(id)
        if (cc) mapCoords.set(id, [cc[0], cc[1]])
      }

      day.stopIds = sortIdsByNearestNeighbor(
        day.stopIds,
        startLat,
        startLon,
        mapCoords,
      )
      day.viaPoints = []  // los índices cambian al reordenar
      persistRoutes()
      rebuildRouteUi()
      void rebuildRouteLine()
    },
  )

  document.querySelector<HTMLButtonElement>('#btn-export')!.addEventListener(
    'click',
    () => {
      const blob = new Blob([JSON.stringify(exportPayload(), null, 2)], {
        type: 'application/json',
      })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'nyc-map-backup.json'
      a.click()
      URL.revokeObjectURL(a.href)
    },
  )

  document.querySelector<HTMLInputElement>('#file-import')!.addEventListener(
    'change',
    async (ev) => {
      const file = (ev.target as HTMLInputElement).files?.[0]
      ;(ev.target as HTMLInputElement).value = ''
      if (!file) return
      try {
        const text = await file.text()
        const data = JSON.parse(text) as {
          version?: number
          visited?: string[]
          userPois?: PoiFeature[]
          routes?: RoutesPayload
        }

        if (Array.isArray(data.visited)) {
          visited = new Set(data.visited.filter((x) => typeof x === 'string'))
          persistVisited()
        }
        if (Array.isArray(data.userPois)) {
          userFeatures = data.userPois.filter(
            (x): x is PoiFeature =>
              typeof x === 'object' &&
              x !== null &&
              (x as PoiFeature).type === 'Feature',
          )
          persistUsers()
        }
        if (data.routes?.days && Array.isArray(data.routes.days)) {
          routesPayload = {
            days: data.routes.days.map((d, i) => ({
              id: typeof d.id === 'string' ? d.id : `import-day-${i}`,
              label: typeof d.label === 'string' ? d.label : `Día ${i + 1}`,
              stopIds: Array.isArray(d.stopIds) ?
                d.stopIds.filter((x): x is string => typeof x === 'string')
              : [],
              viaPoints: Array.isArray(d.viaPoints) ?
                (d.viaPoints as unknown[]).filter(
                  (v): v is ViaPoint =>
                    typeof v === 'object' && v !== null &&
                    typeof (v as Record<string, unknown>).afterStopIndex === 'number' &&
                    typeof (v as Record<string, unknown>).lat === 'number' &&
                    typeof (v as Record<string, unknown>).lng === 'number',
                )
              : [],
            })),
          }
          activeDayId = routesPayload.days[0]?.id ?? activeDayId
          persistRoutes()
        }

        rebuildCoordIndex()
        rebuildMarkers()
        rebuildSidebarList()
        rebuildRouteUi()
        void rebuildRouteLine()
        document.querySelector<HTMLParagraphElement>('#gps-hint')!.textContent =
          'Datos importados.'
      } catch {
        document.querySelector<HTMLParagraphElement>('#gps-hint')!.textContent =
          'Importación fallida: JSON inválido.'
      }
    },
  )

  document.querySelector<HTMLButtonElement>('#dlg-cancel')!.addEventListener(
    'click',
    () => document.querySelector<HTMLDialogElement>('#dlg-add')!.close(),
  )

  document.querySelector<HTMLFormElement>('#form-add')!.addEventListener(
    'submit',
    (e) => {
      e.preventDefault()
      const form = e.target as HTMLFormElement
      const fd = new FormData(form)
      const name = String(fd.get('name') ?? '').trim()
      const category = String(fd.get('category') ?? 'other')
      const notes = String(fd.get('notes') ?? '').trim()
      const photo = String(fd.get('photo') ?? '').trim()
      const lat = Number(fd.get('lat'))
      const lng = Number(fd.get('lng'))

      if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return

      const dup = closestDuplicateMeters(lat, lng)
      if (dup !== null && dup < DEDUP_METERS) {
        const ok = confirm(
          `Hay otro punto a solo ${Math.round(dup)} m. ¿Guardar igualmente?`,
        )
        if (!ok) return
      }

      const id = `user-${crypto.randomUUID()}`
      const feat: PoiFeature = {
        type: 'Feature',
        properties: {
          id,
          name,
          category,
          notes: notes || undefined,
          user: true,
        },
        geometry: { type: 'Point', coordinates: [lng, lat] },
      }

      if (photo) {
        photoOverrides.set(id, photo)
        savePhotos(photoOverrides)
      }

      userFeatures.push(feat)
      persistUsers()
      rebuildCoordIndex()
      rebuildMarkers()
      rebuildSidebarList()
      rebuildRouteUi()

      document.querySelector<HTMLDialogElement>('#dlg-add')!.close()
      stopAddMode()
    },
  )

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (addMode) stopAddMode()
      if (routeEditMode) stopRouteEditMode()
    }
  })

  const routeUl = document.querySelector<HTMLUListElement>('#route-stops')!
  let routeDragId: string | null = null

  routeUl.addEventListener('dragstart', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('.route-li')
    if (!li || !routeUl.contains(li)) return
    routeDragId = li.dataset.id ?? null
    li.classList.add('dragging')
  })

  routeUl.addEventListener('dragend', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('.route-li')
    li?.classList.remove('dragging')
    routeDragId = null
  })

  routeUl.addEventListener(
    'dragover',
    (e) => {
      e.preventDefault()
      const d = currentDay()
      if (!d || !routeDragId) return
      const after = getDragAfterElement(routeUl, e.clientY)
      const dragging = routeUl.querySelector<HTMLElement>(
        `[data-id="${routeDragId}"]`,
      )
      if (!dragging) return
      if (!after) routeUl.appendChild(dragging)
      else routeUl.insertBefore(dragging, after)
    },
    { passive: false },
  )

  routeUl.addEventListener(
    'drop',
    (e) => {
      e.preventDefault()
      const d = currentDay()
      if (!d) return
      const ids = [...routeUl.querySelectorAll<HTMLLIElement>('.route-li')].map(
        (li) => li.dataset.id!,
      )
      d.stopIds = ids
      d.viaPoints = []  // los índices cambian al reordenar
      persistRoutes()
      void rebuildRouteLine()
    },
    { passive: false },
  )

  document.querySelector<HTMLInputElement>('#chk-share-location')!.addEventListener('change', async (e) => {
    if ((e.target as HTMLInputElement).checked) await startSharing()
    else await stopSharing()
  })
}

async function bootstrap(): Promise<void> {
  fillCategorySelects()
  fillZoneSelect()

  const res = await fetch(`${import.meta.env.BASE_URL}data/nyc-pois.geojson`)
  const fc = (await res.json()) as { features: PoiFeature[] }
  seedFeatures = fc.features ?? []
  rebuildCoordIndex()

  map = L.map('map', {
    zoomControl: true,
    maxBounds: METRO_BOUNDS,
    maxBoundsViscosity: 1,
    minZoom: 10,
  }).setView(NYC_CENTER, 12)

  map.createPane('zoneDim')
  const zoneDimPane = map.getPane('zoneDim')
  if (zoneDimPane) {
    zoneDimPane.style.zIndex = '395'
    zoneDimPane.style.pointerEvents = 'none'
  }
  zoneDimLayerGroup = L.layerGroup()

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
  }).addTo(map)

  cluster = L.markerClusterGroup({
    chunkDelay: 50,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    maxClusterRadius: 56,
    iconCreateFunction(clusterGroup) {
      const n = clusterGroup.getChildCount()
      return L.divIcon({
        html: `<div class="cluster-sticker"><span class="cluster-sticker__n">${n}</span><span class="cluster-sticker__lbl">sitios</span></div>`,
        className: 'cluster-sticker-shell',
        iconSize: [52, 52],
        iconAnchor: [26, 26],
      })
    },
  })
  map.addLayer(cluster)

  // Marcador fijo del hotel base (siempre visible, no filtrable)
  const homeIcon = L.divIcon({
    className: 'map-sticker-shell',
    html: `<div class="map-sticker map-sticker--home" style="--sticker-ring:#f59e0b" role="img" aria-label="${HOME_BASE.label}"><span class="map-sticker__emoji">🏨</span></div>`,
    iconSize: [48, 54],
    iconAnchor: [24, 50],
    popupAnchor: [0, -46],
  })
  L.marker([HOME_BASE.lat, HOME_BASE.lng], { icon: homeIcon, zIndexOffset: 1000 })
    .bindPopup(`<div class="popup-inner"><strong>🏨 ${HOME_BASE.label}</strong><div class="popup-tags">Base del viaje</div></div>`)
    .addTo(map)

  syncStickerTier()
  map.on('zoomend', syncStickerTier)

  map.on('click', (ev) => {
    if (routeEditMode) {
      const d = currentDay()
      if (!d || d.stopIds.length < 2) {
        document.querySelector<HTMLParagraphElement>('#gps-hint')!.textContent =
          'Añade al menos 2 paradas al día activo antes de editar la ruta.'
        return
      }
      if (!d.viaPoints) d.viaPoints = []
      d.viaPoints.push({
        afterStopIndex: nearestStopSegment(ev.latlng.lat, ev.latlng.lng, d),
        lat: ev.latlng.lat,
        lng: ev.latlng.lng,
      })
      persistRoutes()
      void rebuildRouteLine()
      return
    }
    if (!addMode) return
    openAddDialog(ev.latlng)
  })

  wireUi()
  rebuildMarkers()
  rebuildSidebarList()
  rebuildRouteUi()
  void rebuildRouteLine()

  if (isFirebaseConfigured()) {
    watchSharedRoutes((remotePayload) => {
      if (!remotePayload) {
        // Firebase vacío → subir datos locales para que todos los vean
        void saveSharedRoutes(routesPayload)
        return
      }
      const remoteJson = JSON.stringify(remotePayload)
      if (remoteJson === JSON.stringify(routesPayload)) return
      routesPayload = remotePayload
      activeDayId =
        routesPayload.days.find((d) => d.id === activeDayId)?.id ??
        routesPayload.days[0]?.id ??
        activeDayId
      saveRoutes(routesPayload)
      rebuildRouteUi()
      void rebuildRouteLine()
      if (activeTab === 'food') rebuildFoodTab()
    })
  }
}

bootstrap().catch((err) => {
  console.error(err)
  document.querySelector<HTMLParagraphElement>('#gps-hint')!.textContent =
    'Error cargando el mapa o los datos.'
})
