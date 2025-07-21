import { ethers } from "ethers";
import { solidityFollowSlot } from "@unruggable/gateways";
import { RPC_URL, ETH_REGISTRAR } from "./constants.js";

const provider = new ethers.JsonRpcProvider(RPC_URL, 1, {
	staticNetwork: true,
});

const owner = await provider
	.getStorage(
		ETH_REGISTRAR.address,
		solidityFollowSlot(ETH_REGISTRAR.slots.owners, ethers.id("raffy"))
	)
	.then((x) => "0x" + x.slice(-40));

const expiry = Number(
	await provider.getStorage(
		ETH_REGISTRAR.address,
		solidityFollowSlot(ETH_REGISTRAR.slots.expiries, ethers.id("raffy"))
	)
);

console.log({ owner, expiry, exp: new Date(1000 * expiry) });
