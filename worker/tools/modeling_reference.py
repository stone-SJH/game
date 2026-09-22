"""Binary silhouette comparison using Blender's image decoder, without extra dependencies."""
import bpy


def mask(file):
    image = bpy.data.images.load(str(file), check_existing=False)
    w, h = image.size
    if not w or not h or w*h > 16000000:
        raise ValueError('Invalid or oversized reference mask')
    pixels = list(image.pixels)
    alpha = any(pixels[i] < .99 for i in range(3,len(pixels),4))
    bits = [(pixels[i+3] > .5 if alpha else sum(pixels[i:i+3])/3 > .5) for i in range(0,len(pixels),4)]
    bpy.data.images.remove(image)
    coords = [(i%w,i//w) for i,v in enumerate(bits) if v]
    if not coords:
        raise ValueError('Empty reference silhouette')
    x0,x1 = min(x for x,y in coords),max(x for x,y in coords)
    y0,y1 = min(y for x,y in coords),max(y for x,y in coords)
    bw,bh = x1-x0+1,y1-y0+1
    normalized = [bits[(y0+min(bh-1,int(y*bh/128)))*w+x0+min(bw-1,int(x*bw/128))] for y in range(128) for x in range(128)]
    return normalized,bw/bh


def compare(reference, rendered, min_iou, max_aspect_error):
    a,aa = mask(reference)
    b,ba = mask(rendered)
    intersection = sum(x and y for x,y in zip(a,b))
    union = sum(x or y for x,y in zip(a,b))
    iou = intersection/union if union else 0
    aspect_error = abs(aa-ba)/aa
    return {'status': 'PASS' if iou >= min_iou and aspect_error <= max_aspect_error else 'GAP',
            'iou': iou, 'aspectError': aspect_error, 'minIoU': min_iou, 'maxAspectError': max_aspect_error,
            'method': 'cropped binary silhouette normalized to 128 square; independent aspect ratio'}
