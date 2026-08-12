import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

/**
 * 数据 IO 层 — GLTFExporter 导出 .glb 二进制模型
 */
export class Exporter {
  async exportGLB(sceneManager, filename = 'glimmerbook-scene.glb') {
    // 过滤掉异常状态下可能残留的空 mesh/null 对象，避免 GLTFExporter.parse 抛错
    const meshes = [...sceneManager.objects.values()].map(o => o?.mesh).filter(Boolean);
    if (meshes.length === 0) {
      throw new Error('场景为空，无法导出');
    }
    // 清洗文件名：去掉路径分隔符/控制字符，防止下载名异常
    const safeName = String(filename).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'glimmerbook-scene.glb';

    const exporter = new GLTFExporter();

    return new Promise((resolve, reject) => {
      exporter.parse(
        meshes,
        (result) => {
          try {
            const blob = new Blob([result], { type: 'model/gltf-binary' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = safeName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            // 等待浏览器完成下载初始化后再释放 URL，避免部分浏览器下载空文件
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            resolve(true);
          } catch (err) {
            reject(err);
          }
        },
        (error) => {
          console.error('[Exporter] GLB export failed:', error);
          reject(error);
        },
        { binary: true }
      );
    });
  }
}
