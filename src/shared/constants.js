/** 默认材质定义 — 各层共享，避免散落的魔法数字 */
export const DEFAULT_MATERIAL = Object.freeze({ color: '#cccccc', metalness: 0.1, roughness: 0.7 });

/** 变换工具模式 → 显示名称 */
export const MODE_NAMES = Object.freeze({ translate: '移动', rotate: '旋转', scale: '缩放' });

/** 基础图元类型 → 显示名称（低面体通过去掉 low 前缀共享） */
export const TYPE_NAMES = {
  cube: '立方体', sphere: '球体', cylinder: '圆柱', plane: '平面',
  lowcube: '低面立方体', lowsphere: '低面球体', lowcylinder: '低面圆柱', model: '模型',
};

/** 基础图元类型 → 图标 */
export const TYPE_ICONS = { cube: '▦', sphere: '●', cylinder: '▮', plane: '▬' };