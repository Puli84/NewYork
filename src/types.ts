export type PoiCategory =
  | 'museum'
  | 'park'
  | 'viewpoint'
  | 'historic'
  | 'food'
  | 'neighborhood'
  | 'bridge'
  | 'other'

export interface PoiProps {
  id: string
  name: string
  category: string
  notes?: string
  user?: boolean
  photo?: string  // URL de imagen para el sticker
}

export interface PoiFeature {
  type: 'Feature'
  properties: PoiProps
  geometry: { type: 'Point'; coordinates: [number, number] }
}

export interface PoiFeatureCollection {
  type: 'FeatureCollection'
  features: PoiFeature[]
}

export interface ViaPoint {
  /** Índice del stop ANTES de este via point (insertado entre stopIds[i] y stopIds[i+1]). */
  afterStopIndex: number
  lat: number
  lng: number
}

export interface RouteDay {
  id: string
  label: string
  stopIds: string[]
  viaPoints?: ViaPoint[]
}

export interface RoutesPayload {
  days: RouteDay[]
}
