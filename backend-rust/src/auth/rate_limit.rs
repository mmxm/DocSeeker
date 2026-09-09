use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_FAILED_ATTEMPTS: u32 = 5;
const LOCKOUT_DURATION: Duration = Duration::from_secs(15 * 60); // 15 minutes

struct AttemptRecord {
    count: u32,
    last_attempt: Instant,
    locked_until: Option<Instant>,
}

pub struct LoginRateLimiter {
    records: Mutex<HashMap<String, AttemptRecord>>,
}

impl LoginRateLimiter {
    pub fn new() -> Self {
        Self {
            records: Mutex::new(HashMap::new()),
        }
    }

    /// Vérifie si l'adresse IP est actuellement bloquée.
    pub fn check_allowed(&self, ip: &str) -> Result<(), Duration> {
        let mut records = self.records.lock().unwrap();
        let now = Instant::now();

        if let Some(record) = records.get(ip) {
            if let Some(locked_until) = record.locked_until {
                if now < locked_until {
                    return Err(locked_until.duration_since(now));
                }
            }
        }

        // Nettoyage périodique des vieux enregistrements (> 1 heure)
        records.retain(|_, v| now.duration_since(v.last_attempt) < Duration::from_secs(3600));

        Ok(())
    }

    /// Enregistre un échec de connexion pour l'adresse IP.
    pub fn record_failure(&self, ip: &str) {
        let mut records = self.records.lock().unwrap();
        let now = Instant::now();

        let record = records.entry(ip.to_string()).or_insert(AttemptRecord {
            count: 0,
            last_attempt: now,
            locked_until: None,
        });

        record.last_attempt = now;
        record.count += 1;

        if record.count >= MAX_FAILED_ATTEMPTS {
            record.locked_until = Some(now + LOCKOUT_DURATION);
        }
    }

    /// Réinitialise le compteur après une connexion réussie.
    pub fn record_success(&self, ip: &str) {
        let mut records = self.records.lock().unwrap();
        records.remove(ip);
    }
}
