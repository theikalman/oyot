use iroh_gossip::net::Gossip;
use iroh_gossip::proto::TopicId;
use std::sync::Arc;

pub struct GossipBroadcaster {
    gossip: Arc<Gossip>,
    topic_id: TopicId,
}

impl GossipBroadcaster {
    pub fn new(gossip: Gossip, topic_id: TopicId) -> Self {
        Self {
            gossip: Arc::new(gossip),
            topic_id,
        }
    }

    pub fn topic_id(&self) -> TopicId {
        self.topic_id
    }

    pub async fn broadcast(&self, msg: Vec<u8>) -> Result<(), String> {
        let gossip = self.gossip.clone();
        let topic_id = self.topic_id;

        let topic = gossip
            .subscribe(topic_id, vec![])
            .await
            .map_err(|e| format!("Failed to subscribe: {}", e))?;

        let mut topic = topic;
        topic
            .broadcast(msg.into())
            .await
            .map_err(|e| format!("Broadcast error: {}", e))?;

        Ok(())
    }

    pub fn gossip(&self) -> &Arc<Gossip> {
        &self.gossip
    }
}

pub fn bytes_to_topic_id(input: &str) -> TopicId {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let result: [u8; 32] = hasher.finalize().into();
    TopicId::from_bytes(result)
}