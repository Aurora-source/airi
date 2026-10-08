import { createPinia } from 'pinia'
import { createApp } from 'vue'

import Gallery from './gallery.vue'

import 'virtual:uno.css'

createApp(Gallery).use(createPinia()).mount('#app')
