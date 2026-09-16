<?php

namespace App\Models;

use MongoDB\Laravel\Eloquent\Model;

/**
 * MongoDB model untuk isi pesan.
 * SQL Server hanya menyimpan header/metadata conversation.
 * Isi pesan (termasuk content polymorphic) disimpan di sini.
 */
class Message extends Model
{
    protected $connection = 'mongodb';
    protected $collection = 'messages';

    protected $fillable = [
        'company_id',
        'conversation_id',
        'channel_id',
        'channel_type',
        'direction',
        'sender_type',
        'sender_id',
        'content_type',
        'content',
        'quoted_message_id',
        'quoted_preview',
        'status',
        'status_history',
        'error_code',
        'error_message',
        'provider_message_id',
        'provider_timestamp',
        'is_deleted',
        'is_automated',
        'bot_intent',
        'flow_id',
    ];

    protected $casts = [
        'content'          => 'array',
        'status_history'   => 'array',
        'is_deleted'       => 'boolean',
        'is_automated'     => 'boolean',
        'provider_timestamp' => 'datetime',
    ];
}
