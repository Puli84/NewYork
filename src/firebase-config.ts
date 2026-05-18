// Rellena estos valores con los de tu proyecto Firebase:
// console.firebase.google.com → tu proyecto → ⚙️ Configuración → Tus apps → SDK
export const firebaseConfig = {
  apiKey: 'AIzaSyCXeiCnvt-v3ERy4ZA17RhDGgt6gMN52Z4',
  authDomain: 'nycmaps-d4bfc.firebaseapp.com',
  databaseURL: 'https://nycmaps-d4bfc-default-rtdb.firebaseio.com',
  projectId: 'nycmaps-d4bfc',
}

export function isFirebaseConfigured(): boolean {
  return firebaseConfig.apiKey !== 'TU_API_KEY'
}
