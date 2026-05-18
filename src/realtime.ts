import { initializeApp } from 'firebase/app'
import {
  getDatabase,
  ref,
  set,
  onValue,
  remove,
  off,
  onDisconnect,
  type Database,
} from 'firebase/database'
import { firebaseConfig } from './firebase-config.ts'
import type { RoutesPayload } from './types.ts'

export interface TravelerData {
  name: string
  lat: number
  lng: number
  color: string
  updatedAt: number
}

const STALE_MS = 10 * 60 * 1000  // 10 min sin actualizar → se oculta

let db: Database | null = null

function getDb(): Database {
  if (!db) {
    const app = initializeApp(firebaseConfig)
    db = getDatabase(app)
  }
  return db
}

export function getOrCreateUserId(): string {
  let id = localStorage.getItem('nyc-traveler-id')
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem('nyc-traveler-id', id)
  }
  return id
}

/** Publica la posición del viajero y registra limpieza automática al desconectarse. */
export async function publishPosition(
  userId: string,
  name: string,
  lat: number,
  lng: number,
  color: string,
): Promise<void> {
  const database = getDb()
  const userRef = ref(database, `travelers/${userId}`)
  // Al cerrar el navegador Firebase elimina el registro automáticamente
  void onDisconnect(userRef).remove()
  await set(userRef, { name, lat, lng, color, updatedAt: Date.now() })
}

/** Escucha cambios de todos los viajeros. Devuelve función para dejar de escuchar. */
export function watchTravelers(
  callback: (travelers: Map<string, TravelerData>) => void,
): () => void {
  const database = getDb()
  const travelersRef = ref(database, 'travelers')
  onValue(travelersRef, (snapshot) => {
    const now = Date.now()
    const result = new Map<string, TravelerData>()
    const data = snapshot.val() as Record<string, TravelerData> | null
    if (data) {
      for (const [id, t] of Object.entries(data)) {
        if (now - t.updatedAt < STALE_MS) result.set(id, t)
      }
    }
    callback(result)
  })
  return () => off(travelersRef)
}

export async function removeMe(userId: string): Promise<void> {
  const database = getDb()
  await remove(ref(database, `travelers/${userId}`))
}

/** Guarda las rutas compartidas en Firebase (visible para todos). */
export async function saveSharedRoutes(payload: RoutesPayload): Promise<void> {
  const database = getDb()
  await set(ref(database, 'routes/shared'), payload)
}

/** Escucha cambios en las rutas compartidas. Llama callback con null si no hay datos aún. */
export function watchSharedRoutes(
  callback: (payload: RoutesPayload | null) => void,
): () => void {
  const database = getDb()
  const routesRef = ref(database, 'routes/shared')
  onValue(routesRef, (snapshot) => {
    const data = snapshot.val() as RoutesPayload | null
    callback(data?.days && Array.isArray(data.days) ? data : null)
  })
  return () => off(routesRef)
}
