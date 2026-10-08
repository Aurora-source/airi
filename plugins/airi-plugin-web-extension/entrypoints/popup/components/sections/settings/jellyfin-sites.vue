<script lang="ts" setup>
import { Button } from '@proj-airi/ui'
import { computed, onMounted, ref } from 'vue'

import { originOf } from '../../../../../src/shared/jellyfin'

const emit = defineEmits<{
  (event: 'apply'): void
}>()
const originsModel = defineModel<string[]>('origins', { required: true })

const tabOrigin = ref<string>()
const message = ref<string>()
const allowed = computed(() => tabOrigin.value !== undefined && originsModel.value.includes(tabOrigin.value))

onMounted(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  tabOrigin.value = tab?.url ? originOf(tab.url) : undefined
})

// The browser asks the user for this one origin. Only an origin that the user granted becomes a Jellyfin site.
async function allowTab() {
  const origin = tabOrigin.value
  if (!origin || allowed.value)
    return
  const granted = await browser.permissions.request({ origins: [`${origin}/*`] }).catch(() => false)
  if (!granted) {
    message.value = 'The browser did not grant access to this site.'
    return
  }
  originsModel.value = [...originsModel.value, origin]
  message.value = undefined
  emit('apply')
}

async function remove(origin: string) {
  originsModel.value = originsModel.value.filter(item => item !== origin)
  await browser.permissions.remove({ origins: [`${origin}/*`] }).catch(() => false)
  emit('apply')
}
</script>

<template>
  <section :class="['rounded-2xl', 'bg-white/6', 'border', 'border-white/10', 'p-3', 'flex', 'flex-col', 'gap-3']">
    <h2 :class="['text-sm', 'font-600']">
      Jellyfin sites
    </h2>
    <p :class="['text-xs', 'opacity-70', 'leading-snug']">
      Allow your Jellyfin server's address. AIRI then reads playback and captions on its pages.
    </p>
    <Button v-if="tabOrigin && !allowed" variant="secondary" size="sm" @click="allowTab">
      Allow {{ tabOrigin }} as Jellyfin
    </Button>
    <p v-if="message" :class="['text-xs', 'text-orange-400']">
      {{ message }}
    </p>
    <ul v-if="originsModel.length > 0" :class="['flex', 'flex-col', 'gap-2']">
      <li v-for="origin in originsModel" :key="origin" :class="['flex', 'items-center', 'justify-between', 'gap-2', 'text-xs']">
        <span :class="['truncate']">{{ origin }}</span>
        <Button variant="secondary" size="sm" @click="remove(origin)">
          Remove
        </Button>
      </li>
    </ul>
  </section>
</template>
