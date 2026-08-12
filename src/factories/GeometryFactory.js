import * as THREE from 'three';
import { DEFAULT_MATERIAL } from '../shared/constants.js';

/**
 * 几何体工厂 — 四种基础几何体的创建函数，统一返回带默认材质的 Mesh
 */

const DEFAULTS = {
  cube:     { width: 1, height: 1, depth: 1, widthSegments: 1, heightSegments: 1, depthSegments: 1 },
  sphere:   { radius: 0.7, widthSegments: 24, heightSegments: 16 },
  cylinder: { radiusTop: 0.5, radiusBottom: 0.5, height: 1.4, radialSegments: 24 },
  plane:    { width: 2, height: 2, widthSegments: 1, heightSegments: 1 },
};

const LOW_POLY_DEFAULTS = {
  lowcube:   { width: 1, height: 1, depth: 1, widthSegments: 1, heightSegments: 1, depthSegments: 1 },
  lowsphere: { radius: 0.7, widthSegments: 8, heightSegments: 5 },
  lowcylinder: { radiusTop: 0.5, radiusBottom: 0.5, height: 1.4, radialSegments: 8 },
};

function finiteNumber(value, fallback, minimum = -Infinity) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : fallback;
}

/** 细分段数：夹到 [minimum, maximum]，防外部传入超大值导致几何体 OOM 崩溃 */
function segmentCount(value, fallback, minimum = 1, maximum = 1000) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.floor(number))) : fallback;
}

export class GeometryFactory {
  create(type, params = {}) {
    if (typeof type !== 'string') {
      console.warn('[GeometryFactory] type must be a string');
      return null;
    }
    const lowPoly = type.startsWith('low');
    const baseType = lowPoly ? type.slice(3) : type;
    const defaults = lowPoly ? LOW_POLY_DEFAULTS[type] : DEFAULTS[baseType];
    if (!defaults) {
      console.warn(`[GeometryFactory] unknown type: ${type}`);
      return null;
    }
    const safeParams = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
    const p = { ...defaults, ...safeParams };
    if (baseType === 'cube') {
      p.width = finiteNumber(p.width, defaults.width, 0.01);
      p.height = finiteNumber(p.height, defaults.height, 0.01);
      p.depth = finiteNumber(p.depth, defaults.depth, 0.01);
      p.widthSegments = segmentCount(p.widthSegments, defaults.widthSegments);
      p.heightSegments = segmentCount(p.heightSegments, defaults.heightSegments);
      p.depthSegments = segmentCount(p.depthSegments, defaults.depthSegments);
    } else if (baseType === 'sphere') {
      p.radius = finiteNumber(p.radius, defaults.radius, 0.01);
      p.widthSegments = segmentCount(p.widthSegments, defaults.widthSegments, 3);
      p.heightSegments = segmentCount(p.heightSegments, defaults.heightSegments, 2);
    } else if (baseType === 'cylinder') {
      p.radiusTop = finiteNumber(p.radiusTop, defaults.radiusTop, 0);
      p.radiusBottom = finiteNumber(p.radiusBottom, defaults.radiusBottom, 0);
      p.height = finiteNumber(p.height, defaults.height, 0.01);
      p.radialSegments = segmentCount(p.radialSegments, defaults.radialSegments, 3);
    } else if (baseType === 'plane') {
      p.width = finiteNumber(p.width, defaults.width, 0.01);
      p.height = finiteNumber(p.height, defaults.height, 0.01);
      p.widthSegments = segmentCount(p.widthSegments, defaults.widthSegments);
      p.heightSegments = segmentCount(p.heightSegments, defaults.heightSegments);
    }
    let geometry;

    switch (baseType) {
      case 'cube':
        geometry = new THREE.BoxGeometry(
          Math.max(0.01, p.width), Math.max(0.01, p.height), Math.max(0.01, p.depth),
          p.widthSegments, p.heightSegments, p.depthSegments
        );
        break;
      case 'sphere':
        geometry = new THREE.SphereGeometry(
          Math.max(0.01, p.radius), p.widthSegments, p.heightSegments
        );
        break;
      case 'cylinder':
        geometry = new THREE.CylinderGeometry(
          Math.max(0, p.radiusTop), Math.max(0, p.radiusBottom),
          Math.max(0.01, p.height), p.radialSegments
        );
        break;
      case 'plane':
        geometry = new THREE.PlaneGeometry(
          Math.max(0.01, p.width), Math.max(0.01, p.height),
          p.widthSegments, p.heightSegments
        );
        break;
      default:
        console.warn(`[GeometryFactory] unknown type: ${type}`);
        return null;
    }

    const material = new THREE.MeshStandardMaterial({
      color: DEFAULT_MATERIAL.color,
      metalness: DEFAULT_MATERIAL.metalness,
      roughness: DEFAULT_MATERIAL.roughness,
      side: baseType === 'plane' ? THREE.DoubleSide : THREE.FrontSide,
      flatShading: lowPoly || Boolean(p.flatShading),
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Position objects to sit on the grid
    if (baseType === 'plane') {
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.01;
    } else if (baseType === 'sphere') {
      mesh.position.y = p.radius;
    } else if (baseType === 'cylinder') {
      mesh.position.y = p.height / 2;
    } else if (baseType === 'cube') {
      mesh.position.y = p.height / 2;
    }

    const data = {
      type,
      primitive: baseType,
      lowPoly,
      geometry: { ...p },
      material: { ...DEFAULT_MATERIAL },
    };

    return { mesh, data };
  }

  static getDefaults(type) {
    return { ...(DEFAULTS[type] || LOW_POLY_DEFAULTS[type] || {}) };
  }
}
