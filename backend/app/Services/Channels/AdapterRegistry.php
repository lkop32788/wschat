<?php

namespace App\Services\Channels;

/**
 * Registry semua channel adapter.
 * Binding dilakukan di AppServiceProvider agar mudah di-mock saat testing.
 */
class AdapterRegistry
{
    /** @param ChannelAdapterInterface[] $adapters */
    public function __construct(private readonly array $adapters) {}

    /**
     * Temukan adapter yang cocok dengan channel type.
     *
     * @throws \InvalidArgumentException Jika tidak ada adapter untuk channel type ini
     */
    public function forChannel(string $channelType): ChannelAdapterInterface
    {
        foreach ($this->adapters as $adapter) {
            if ($adapter->supports($channelType)) {
                return $adapter;
            }
        }

        throw new \InvalidArgumentException("No adapter registered for channel type: {$channelType}");
    }
}
