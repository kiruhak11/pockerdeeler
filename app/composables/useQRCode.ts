import QRCode from 'qrcode'

export function useQRCode() {
  async function generateQrDataUrl(text: string) {
    return QRCode.toDataURL(text, {
      margin: 1,
      scale: 6
    })
  }

  return {
    generateQrDataUrl
  }
}
