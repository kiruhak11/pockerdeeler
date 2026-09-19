<script setup lang="ts">
import RocketGame from '~/components/minigames/RocketGame.vue'
import AppIcon from '~/components/ui/AppIcon.vue'
const auth = useAccountAuth()
onMounted(() => void auth.loadMe().catch(() => {}))
</script>
<template><main class="arcade"><NuxtLink class="arcade-back" to="/minigames"><AppIcon name="arrow-left" :size="16" /> Все мини-игры</NuxtLink><RocketGame/></main></template>
<style src="~/assets/css/arcade.css"/>
