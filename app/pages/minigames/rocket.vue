<script setup lang="ts">
import RocketGame from '~/components/minigames/RocketGame.vue'
const auth = useAccountAuth()
onMounted(() => void auth.loadMe().catch(() => {}))
</script>
<template><main class="arcade"><NuxtLink class="arcade-back" to="/minigames">← Все мини-игры</NuxtLink><RocketGame/></main></template>
<style src="~/assets/css/arcade.css"/>
