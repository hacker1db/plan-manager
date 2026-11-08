import { hostedLibraryShell } from '@/hosted/lib/dashboard'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = () => ({ shell: hostedLibraryShell() })
