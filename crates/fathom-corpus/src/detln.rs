//! Deterministic natural log, 16 §5.4. `f64::ln` routes to libm and is not
//! bit-identical across implementations; IDF/ICF must be identical across
//! targets (invariant 9, X0.5). This implementation uses only IEEE-754 basic
//! operations (+ − × ÷), which are exactly rounded and therefore identical on
//! every conforming target. Accuracy ≈ 1e-14 over the domain used here
//! (x ≥ 1), far inside the milli-nat quantisation the index stores.

/// ln(x) for finite x > 0, deterministic across targets.
pub fn det_ln(x: f64) -> f64 {
    debug_assert!(x > 0.0 && x.is_finite());
    let bits = x.to_bits();
    let mut e = ((bits >> 52) & 0x7ff) as i64 - 1023;
    let mut m = f64::from_bits((bits & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000);
    // Reduce m toward 1 so the series converges fast: if m > sqrt(2), halve it
    // and carry the doubling into the exponent.
    if m > core::f64::consts::SQRT_2 {
        m /= 2.0;
        e += 1;
    }
    // atanh series: ln m = 2·Σ z^(2k+1)/(2k+1), z = (m−1)/(m+1), |z| ≤ 0.1716.
    let z = (m - 1.0) / (m + 1.0);
    let z2 = z * z;
    let mut term = z;
    let mut sum = 0.0;
    let mut k = 0u32;
    while k <= 10 {
        sum += term / f64::from(2 * k + 1);
        term *= z2;
        k += 1;
    }
    2.0 * sum + (e as f64) * core::f64::consts::LN_2
}

/// `round(1000 · ln(x))` as the quantised milli-nat the index stores.
pub fn ln_milli(x: f64) -> u32 {
    let v = det_ln(x) * 1000.0;
    if v <= 0.0 {
        0
    } else {
        (v + 0.5) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_std_ln_to_quantisation() {
        // The pinned IDF form: ln(1 + (N−df+0.5)/(df+0.5)) over realistic
        // values, plus the worked constants from 16 §12.4.
        for x in [
            1.0004, 1.5, 2.0, 5.0, 8.548, 12.446, 20.530, 31.0, 98.0, 1200.0,
        ] {
            let d = (det_ln(x) - x.ln()).abs();
            assert!(d < 1e-12, "det_ln({x}) off by {d}");
        }
        assert_eq!(ln_milli(20.530), 3022); // idf(check), 16 §12.4
        assert_eq!(ln_milli(12.446), 2521); // idf(tunnel)
        assert_eq!(ln_milli(31.0), 3434); // icf(state.operational)
    }
}
