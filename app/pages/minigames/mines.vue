<script setup lang="ts">
import MinesGame from '~/components/minigames/MinesGame.vue'
const auth = useAccountAuth()
onMounted(() => void auth.loadMe().catch(() => {}))
</script>
<template><main class="arcade"><NuxtLink class="arcade-back" to="/minigames">← Все мини-игры</NuxtLink><MinesGame/></main></template>
<style src="~/assets/css/arcade.css"/>
