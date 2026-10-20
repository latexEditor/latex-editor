export class LatexEditorApi {
  constructor(baseUrl = '') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async health() {
    if (!this.baseUrl) return { configured: false, local: true };
    const response = await fetch(`${this.baseUrl}/health`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Cloud health check failed (${response.status})`);
    return response.json();
  }

  async compile({ files, entry = 'main.tex', signal }) {
    if (!this.baseUrl) throw new Error('Chưa cấu hình dịch vụ biên dịch từ xa. Bản xem nhanh vẫn hoạt động cục bộ.');
    const response = await fetch(`${this.baseUrl}/v1/compile`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/pdf' },
      body: JSON.stringify({ files, entry }),
      signal
    });
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      throw new Error(details.error || `Biên dịch thất bại (${response.status})`);
    }
    return response.blob();
  }
}
