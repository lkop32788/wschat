<?php

namespace App\Jobs;

use App\Data\CanonicalMessage;
use App\Models\FailedWebhookEvent;
use App\Models\ProcessedWebhookEvent;
use App\Services\ConversationOrchestrator;
use App\Services\DispatcherBridge;
use App\Services\IdentityResolutionService;
use App\Services\MessagePersistenceService;
use App\Services\RealtimeEventPublisher;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Job utama untuk memproses satu canonical message dari RabbitMQ.
 *
 * URUTAN EKSEKUSI (jangan ubah urutan ini):
 * 1. Idempotency check  → skip jika sudah diproses
 * 2. Identity resolve   → contact_id
 * 3. Conversation find  → conversation_id
 * 4. Persist ke MongoDB → mongo_id
 * 5. Update conversation header di SQL
 * 6. Trigger dispatcher → assign agent
 * 7. Publish realtime event → notify frontend
 * 8. Mark idempotency → tandai selesai
 *
 * CATATAN MULTI-DB:
 * SQL + MongoDB tidak bisa dalam satu DB transaction.
 * Urutan aman: SQL dulu, MongoDB kedua.
 * Jika MongoDB gagal setelah SQL sukses → retry job handle idempotency.
 */
class ProcessInboundMessage implements ShouldQueue
{
    use Queueable;

    public int $tries   = 3;
    public array $backoff = [5, 30, 60];

    public function __construct(private readonly CanonicalMessage $message) {}

    public function handle(
        IdentityResolutionService $identity,
        ConversationOrchestrator  $orchestrator,
        MessagePersistenceService $persistence,
        RealtimeEventPublisher    $realtime,
        DispatcherBridge          $dispatcher
    ): void {
        $msg = $this->message;

        // ── 1. Idempotency check ──────────────────────────────────────────────
        $alreadyProcessed = ProcessedWebhookEvent::where('event_id', $msg->event_id)->exists();
        if ($alreadyProcessed) {
            Log::info('Skipping duplicate event', ['event_id' => $msg->event_id]);
            return;
        }

        // ── 2. Identity Resolution ────────────────────────────────────────────
        $contact = $identity->resolve(
            companyId:  $msg->company_id,
            channelType: $msg->channel_type,
            externalId:  $msg->sender_external_id,
            profile: [
                'name'   => $msg->sender_name,
                'avatar' => $msg->sender_avatar,
            ]
        );

        // ── 3. Conversation Lookup / Create ───────────────────────────────────
        $isNewConversation = false;
        $conv = $orchestrator->findOrCreate(
            $msg->company_id,
            $msg->channel_id,
            $contact->id,
            $msg
        );
        $isNewConversation = $conv->wasRecentlyCreated;

        // ── 4. Persist ke MongoDB ─────────────────────────────────────────────
        // MongoDB setelah SQL — jika gagal di sini, retry job akan idempoten
        $mongoId = $persistence->persist($conv, $contact, $msg);

        // ── 5. Update conversation header ─────────────────────────────────────
        $orchestrator->updateAfterMessage($conv, $msg);
        $conv->refresh();

        // ── 6. Trigger dispatcher (jika conversation baru/pending) ────────────
        if ($isNewConversation || $conv->isPending()) {
            $dispatcher->requestDispatch($conv);
        }
        $dispatcher->syncConversationState($conv);

        // ── 7. Publish realtime event ─────────────────────────────────────────
        $realtime->newMessage(
            conv:        $conv,
            mongoMessageId: $mongoId,
            contentType:    $msg->content_type,
            preview:        $msg->getPreview(),
            senderName:     $msg->sender_name ?? $msg->sender_external_id,
            channelType:    $msg->channel_type,
            timestamp:      $msg->provider_timestamp,
        );

        // ── 8. Mark idempotency ───────────────────────────────────────────────
        ProcessedWebhookEvent::create([
            'event_id'     => $msg->event_id,
            'company_id'   => $msg->company_id,
            'channel_type' => $msg->channel_type,
            'processed_at' => now(),
        ]);
    }

    public function failed(Throwable $e): void
    {
        // Jangan log raw_payload — berisi PII
        Log::error('ProcessInboundMessage failed permanently', [
            'event_id'     => $this->message->event_id,
            'company_id'   => $this->message->company_id,
            'channel_type' => $this->message->channel_type,
            'content_type' => $this->message->content_type,
            'error'        => $e->getMessage(),
        ]);

        FailedWebhookEvent::create([
            'event_id'     => $this->message->event_id,
            'company_id'   => $this->message->company_id,
            'channel_type' => $this->message->channel_type,
            'payload'      => json_encode([
                'event_id'           => $this->message->event_id,
                'channel_type'       => $this->message->channel_type,
                'sender_external_id' => $this->message->sender_external_id,
                'content_type'       => $this->message->content_type,
            ]),
            'error'   => $e->getMessage(),
            'attempt' => $this->attempts(),
        ]);
    }
}
