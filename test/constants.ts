import { HexAddress } from "@unruggable/gateways";

export const RPC_URL = process.env.RPC_URL ?? "https://eth.drpc.org";

export const ETH_REGISTRAR = {
	address: "0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85",
	slots: {
		owners: 5n,
		expiries: 9n,
	},
} as const;

export const NAME_WRAPPER = {
	address: "0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401",
	slots: {
		tokens: 1n,
	},
} as const;
