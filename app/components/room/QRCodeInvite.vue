<script setup lang="ts">
const props = defineProps<{
  url: string
}>()

const { generateQrDataUrl } = useQRCode()
const qrSrc = ref('')

watch(
  () => props.url,
  async (value) => {
    qrSrc.value = value ? await generateQrDataUrl(value) : ''
  },
  { immediate: true }
)
</script>

<template>
  <section class="panel qr-code-invite">
    <h3>QR-приглашение</h3>
    <img v-if="qrSrc" :src="qrSrc" alt="QR-код комнаты">
  </section>
</template>

<style scoped lang="scss">
.qr-code-invite {
  display: grid;
  gap: 0.5rem;
  justify-items: center;

  h3 {
    margin: 0;
  }

  img {
    width: 170px;
    height: 170px;
    border-radius: 0.7rem;
    background: #fff;
    padding: 0.3rem;
  }
}
</style>
