use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, Transact};

pub struct CrdtDocument {
    doc: Doc,
}

impl CrdtDocument {
    pub fn new() -> Self {
        Self { doc: Doc::new() }
    }

    pub fn load_from_state(&mut self, blob: &[u8]) -> Result<(), String> {
        if blob.is_empty() {
            return Ok(());
        }
        let update =
            yrs::Update::decode_v1(blob).map_err(|e| format!("Failed to decode state: {}", e))?;
        let mut txn = self.doc.transact_mut();
        txn.apply_update(update)
            .map_err(|e| format!("Failed to apply state: {}", e))?;
        Ok(())
    }

    pub fn apply_update(&mut self, update: &[u8]) -> Result<(), String> {
        if update.is_empty() {
            return Ok(());
        }
        let update = yrs::Update::decode_v1(update)
            .map_err(|e| format!("Failed to decode update: {}", e))?;
        let mut txn = self.doc.transact_mut();
        txn.apply_update(update)
            .map_err(|e| format!("Failed to apply update: {}", e))?;
        Ok(())
    }

    pub fn export_state(&self) -> Vec<u8> {
        let txn = self.doc.transact();
        txn.encode_state_as_update_v1(&yrs::StateVector::default())
    }

    pub fn export_update_since(&self, sv: &yrs::StateVector) -> Result<Vec<u8>, String> {
        let txn = self.doc.transact();
        Ok(txn.encode_state_as_update_v1(sv))
    }
}

impl Default for CrdtDocument {
    fn default() -> Self {
        Self::new()
    }
}
