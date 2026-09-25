<script setup lang="ts">
if (!import.meta.dev) throw createError({ statusCode: 404, statusMessage: 'Not found' })
useHead({ title: 'Yandex iframe security harness · DEV' })
</script>

<template>
  <main class="harness">
    <h1>Yandex iframe security harness</h1>
    <p>Dev only. Set <code>YANDEX_GAMES_FRAME_ANCESTORS=http://localhost:3000</code> and optionally <code>NUXT_PUBLIC_YANDEX_GAMES_MOCK=guest</code>, then restart Nuxt.</p>
    <p>The Yandex frame should load only when its exact parent origin is configured. The ordinary WEB frame should be blocked.</p>
    <section><h2>YANDEX_GAMES: expected to load</h2><iframe title="Yandex Games shell" src="/yandex" /></section>
    <section><h2>WEB: expected to be blocked</h2><iframe title="Ordinary WEB route" src="/rooms" /></section>
  </main>
</template>

<style scoped>
.harness { max-width: 1100px; margin: auto; padding: 1rem; }
section { margin-block: 1.5rem; }
iframe { width: 100%; min-height: 520px; border: 2px solid #777; }
</style>
