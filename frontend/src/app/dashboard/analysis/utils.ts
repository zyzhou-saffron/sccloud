/**
 * 数据集基因总数 = 各上传文件 n_genes(回退 n_cols) 的最大值, 作为 QC「最大基因数」的上限。
 * 单细胞每个细胞的 nFeature 不会超过其样本基因数, 故这是有意义的上限。
 * 无文件 / n_genes 全未知 时回退 10 万, 避免上限为 0 卡死输入。
 */
export function getFeatureCap(files: { n_genes?: number; n_cols?: number }[]): number {
  const max = files.length
    ? Math.max(0, ...files.map((f) => f.n_genes ?? f.n_cols ?? 0))
    : 0;
  return max || 100000;
}
