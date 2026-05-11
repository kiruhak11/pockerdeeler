// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: ['@pinia/nuxt'],
  css: ['~/assets/styles/main.scss'],
  nitro: {
    experimental: {
      websocket: true
    }
  },
  pinia: {
    storesDirs: ['./app/stores/**']
  }
})
