<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;

class AudienceSnapshot extends Model
{
    use HasUuids;

    public $timestamps = false;

    protected $fillable = ['campaign_id', 'company_id', 'total_count'];

    public function recipients()
    {
        return $this->hasMany(AudienceSnapshotRecipient::class, 'snapshot_id');
    }
}
