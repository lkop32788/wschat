<?php

namespace App\Models;

use App\Models\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class ConversationFailoverLog extends Model
{
    use BelongsToTenant, HasUuids;

    public $timestamps = false;

    protected $fillable = [
        'conversation_id',
        'company_id',
        'original_channel_id',
        'failover_channel_id',
        'reason',
        'failed_at',
    ];

    protected $casts = [
        'failed_at' => 'datetime',
    ];

    public function conversation(): BelongsTo
    {
        return $this->belongsTo(Conversation::class);
    }

    public function originalChannel(): BelongsTo
    {
        return $this->belongsTo(Channel::class, 'original_channel_id');
    }

    public function failoverChannel(): BelongsTo
    {
        return $this->belongsTo(Channel::class, 'failover_channel_id');
    }
}
