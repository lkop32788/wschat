<?php

namespace App\Models;

use App\Models\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

class Conversation extends Model
{
    use BelongsToTenant, HasUuids, SoftDeletes;

    protected $fillable = [
        'company_id',
        'channel_id',
        'contact_id',
        'assigned_agent_id',
        'assigned_team_id',
        'status',
        'priority',
        'intent_tags',
        'subject',
        'last_message_preview',
        'last_message_direction',
        'last_message_at',
        'first_response_at',
        'resolved_at',
        'snoozed_until',
        'message_count',
        'unread_count',
        'custom_attributes',
    ];

    protected $casts = [
        'intent_tags'        => 'array',
        'custom_attributes'  => 'array',
        'last_message_at'    => 'datetime',
        'first_response_at'  => 'datetime',
        'resolved_at'        => 'datetime',
        'snoozed_until'      => 'datetime',
        'message_count'      => 'integer',
        'unread_count'       => 'integer',
    ];

    public function company(): BelongsTo
    {
        return $this->belongsTo(Company::class);
    }

    public function channel(): BelongsTo
    {
        return $this->belongsTo(Channel::class);
    }

    public function contact(): BelongsTo
    {
        return $this->belongsTo(Contact::class);
    }

    public function assignedAgent(): BelongsTo
    {
        return $this->belongsTo(User::class, 'assigned_agent_id');
    }

    public function assignments(): HasMany
    {
        return $this->hasMany(ConversationAssignment::class);
    }

    public function isPending(): bool   { return $this->status === 'pending'; }
    public function isOpen(): bool      { return $this->status === 'open'; }
    public function isSnoozed(): bool   { return $this->status === 'snoozed'; }
    public function isResolved(): bool  { return $this->status === 'resolved'; }

    public function scopeForCompany(Builder $query, string $companyId): Builder
    {
        return $query->where('company_id', $companyId);
    }

    public function scopeActive(Builder $query): Builder
    {
        return $query->whereIn('status', ['pending', 'open']);
    }
}
