<?php

namespace App\Services;

use App\Models\Conversation;
use Illuminate\Support\Facades\Redis;

/**
 * Publish event ke Redis Pub/Sub channel yang di-subscribe oleh Realtime Server (Socket.io).
 * Key format mengikuti konvensi dari redis_key_design.js: channel:events:{company_id}
 */
class RealtimeEventPublisher
{
    public function newMessage(
        Conversation $conv,
        string       $mongoMessageId,
        string       $contentType,
        string       $preview,
        string       $senderName,
        string       $channelType,
        string       $timestamp
    ): void {
        $this->publish($conv->company_id, [
            'type'    => 'NEW_MESSAGE',
            'payload' => [
                'conversation_id'   => $conv->id,
                'message_id'        => $mongoMessageId,
                'content_type'      => $contentType,
                'preview'           => $preview,
                'direction'         => 'inbound',
                'sender_name'       => $senderName,
                'channel_type'      => $channelType,
                'timestamp'         => $timestamp,
                'assigned_agent_id' => $conv->assigned_agent_id,
            ],
        ]);
    }

    public function conversationAssigned(Conversation $conv, string $agentId): void
    {
        $this->publish($conv->company_id, [
            'type'    => 'CONVERSATION_ASSIGNED',
            'payload' => [
                'conversation_id' => $conv->id,
                'agent_id'        => $agentId,
                'company_id'      => $conv->company_id,
            ],
        ]);
    }

    public function conversationResolved(Conversation $conv): void
    {
        $this->publish($conv->company_id, [
            'type'    => 'CONVERSATION_RESOLVED',
            'payload' => ['conversation_id' => $conv->id, 'company_id' => $conv->company_id],
        ]);
    }

    public function conversationReopened(Conversation $conv): void
    {
        $this->publish($conv->company_id, [
            'type'    => 'CONVERSATION_REOPENED',
            'payload' => ['conversation_id' => $conv->id, 'company_id' => $conv->company_id],
        ]);
    }

    public function messageStatusUpdate(string $companyId, string $mongoId, string $status): void
    {
        $this->publish($companyId, [
            'type'    => 'MESSAGE_STATUS_UPDATE',
            'payload' => ['message_id' => $mongoId, 'status' => $status],
        ]);
    }

    private function publish(string $companyId, array $event): void
    {
        Redis::publish("channel:events:{$companyId}", json_encode($event));
    }
}
