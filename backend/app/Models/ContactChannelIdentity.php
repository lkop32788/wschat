<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class ContactChannelIdentity extends Model
{
    protected $fillable = [
        'contact_id',
        'company_id',
        'channel_type',
        'external_id',
        'display_name',
        'avatar_url',
        'raw_profile',
    ];

    protected $casts = [
        'raw_profile' => 'array',
    ];

    public function contact(): BelongsTo
    {
        return $this->belongsTo(Contact::class);
    }
}
