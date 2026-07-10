// Converte a foto escolhida para WebP e redimensiona se for maior que o
// necessário, evitando subir arquivos pesados (fotos de celular passam de
// 5-10MB facilmente). Se algo der errado (formato não suportado pelo canvas,
// navegador antigo etc.), devolve o arquivo original em vez de travar o
// upload.
const MAX_DIMENSION = 1600;
const QUALITY = 0.82;

export async function compressImageToWebp(file, { maxDimension = MAX_DIMENSION, quality = QUALITY } = {}) {
  if (!file.type.startsWith('image/')) return file;
  try {
    const image = await loadImage(file);
    const { width, height } = fitDimensions(image.width, image.height, maxDimension);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
    if (!blob) return file;
    const webpName = `${file.name.replace(/\.[^./]+$/, '')}.webp`;
    return new File([blob], webpName, { type: 'image/webp' });
  } catch {
    return file;
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = (error) => {
      URL.revokeObjectURL(url);
      reject(error);
    };
    image.src = url;
  });
}

function fitDimensions(width, height, maxDimension) {
  if (width <= maxDimension && height <= maxDimension) return { width, height };
  const scale = maxDimension / Math.max(width, height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
