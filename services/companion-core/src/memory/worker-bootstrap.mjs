import { register } from 'tsx/esm/api'

// The service runs TypeScript source through tsx. A new thread needs its own loader registration.
register()
void import('./worker')
