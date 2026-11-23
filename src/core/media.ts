import { sha256Hex } from '../lib/encoding'
import { putBlob } from './db'
import type { MediaRef } from './records'

export const MAX_VIDEO_BYTES = 50 * 1024 * 1024
export const MAX_VIDEO_SECONDS = 90
const MAX_IMAGE_EDGE = 1440
const THUMB_EDGE = 360

export type Aspect = 'square' | 'portrait' | 'landscape' | 'original'
export const ASPECTS: Record<Exclude<Aspect, 'original'>, number> = { square: 1, portrait: 4 / 5, landscape: 1.91 }

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not read image'))
    img.src = url
  })
}

function canvasBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', q = 0.86): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, q))
}

/** Center-crop region of (sw, sh) for target aspect, offset by pan (-1..1). */
export function cropRect(sw: number, sh: number, aspect: number, panX = 0, panY = 0) {
  const srcAspect = sw / sh
  let w = sw
  let h = sh
  if (srcAspect > aspect) w = sh * aspect
  else h = sw / aspect
  const x = ((sw - w) / 2) * (1 + panX)
  const y = ((sh - h) / 2) * (1 + panY)
  return { x, y, w, h }
}

function draw(source: CanvasImageSource, sw: number, sh: number, aspect: number, maxEdge: number, panX = 0, panY = 0) {
  const r = cropRect(sw, sh, aspect, panX, panY)
  const scale = Math.min(1, maxEdge / Math.max(r.w, r.h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(r.w * scale)
  canvas.height = Math.round(r.h * scale)
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height)
  return canvas
}

async function store(blob: Blob, mime: string) {
  const hash = await sha256Hex(blob)
  await putBlob(hash, blob, mime)
  return hash
}

export interface Prepared {
  ref: MediaRef
  previewUrl: string
}

export async function processImage(file: Blob, aspect: number | null, pan = { x: 0, y: 0 }): Promise<MediaRef> {
  const img = await loadImage(file)
  URL.revokeObjectURL(img.src)
  const a = aspect ?? img.naturalWidth / img.naturalHeight
  const full = draw(img, img.naturalWidth, img.naturalHeight, a, MAX_IMAGE_EDGE, pan.x, pan.y)
  const thumb = draw(img, img.naturalWidth, img.naturalHeight, a, THUMB_EDGE, pan.x, pan.y)
  const fullBlob = await canvasBlob(full)
  const thumbBlob = await canvasBlob(thumb, 'image/jpeg', 0.75)
  const [hash, thumbHash] = await Promise.all([store(fullBlob, 'image/jpeg'), store(thumbBlob, 'image/jpeg')])
  return { hash, mime: 'image/jpeg', size: fullBlob.size, w: full.width, h: full.height, thumb: thumbHash }
}

export function readVideoMeta(file: Blob): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.preload = 'auto'
    v.muted = true
    v.playsInline = true
    v.onloadeddata = () => resolve(v)
    v.onerror = () => reject(new Error('Unsupported video format'))
    v.src = URL.createObjectURL(file)
  })
}

export async function processVideo(file: File): Promise<MediaRef> {
  if (file.size > MAX_VIDEO_BYTES) throw new Error(`Video is larger than ${MAX_VIDEO_BYTES / 1024 / 1024} MB`)
  const v = await readVideoMeta(file)
  if (v.duration > MAX_VIDEO_SECONDS + 0.5) throw new Error(`Videos can be at most ${MAX_VIDEO_SECONDS} seconds`)
  // poster frame
  await new Promise<void>((res) => {
    v.onseeked = () => res()
    v.currentTime = Math.min(0.5, v.duration / 2)
  })
  const w = v.videoWidth
  const h = v.videoHeight
  const poster = draw(v, w, h, w / h, THUMB_EDGE)
  const posterBlob = await canvasBlob(poster, 'image/jpeg', 0.75)
  URL.revokeObjectURL(v.src)
  const mime = file.type || 'video/mp4'
  const [hash, thumb] = await Promise.all([store(file, mime), store(posterBlob, 'image/jpeg')])
  return { hash, mime, size: file.size, w, h, thumb, duration: v.duration }
}

export async function processAvatar(file: Blob): Promise<MediaRef> {
  const img = await loadImage(file)
  URL.revokeObjectURL(img.src)
  const c = draw(img, img.naturalWidth, img.naturalHeight, 1, 320)
  const blob = await canvasBlob(c, 'image/jpeg', 0.85)
  const hash = await store(blob, 'image/jpeg')
  return { hash, mime: 'image/jpeg', size: blob.size, w: c.width, h: c.height }
}

export const isVideo = (m: { mime: string }) => m.mime.startsWith('video/')
