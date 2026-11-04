import { describe, expect, it } from 'vitest';
import { AdmissionController } from '../../src/difusion/admission/AdmissionController.js';

describe('AdmissionController (RF-10)', () => {
  it('admite como máximo N conexiones nuevas por segundo', () => {
    const admission = new AdmissionController(100, 10, () => 0.5, 0);
    let admitted = 0;
    for (let i = 0; i < 1_000; i++) if (admission.tryAdmit(0).admitted) admitted++;
    expect(admitted).toBe(100);

    let later = 0;
    for (let i = 0; i < 1_000; i++) if (admission.tryAdmit(500).admitted) later++;
    expect(later).toBe(50);
  });

  it('reparte el Retry-After al azar para no repetir la avalancha', () => {
    let seed = 0;
    const admission = new AdmissionController(1, 10, () => (seed++ % 10) / 10, 0);
    admission.tryAdmit(0);
    const retries = new Set<number>();
    for (let i = 0; i < 10; i++) {
      const decision = admission.tryAdmit(0);
      if (!decision.admitted) retries.add(decision.retryAfterSec);
    }
    expect(retries.size).toBe(10);
    expect(Math.min(...retries)).toBeGreaterThanOrEqual(1);
  });
});
