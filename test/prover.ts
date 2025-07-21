import { ethers } from "ethers";
import { RPC_URL } from "./constants.js";
import { generateProof } from "../src/prover.js";

const provider = new ethers.JsonRpcProvider(RPC_URL, 1, {
	staticNetwork: true,
	batchMaxCount: 3,
});

console.log(
	await generateProof(
		provider,
		BigInt(await provider.getBlockNumber()),
		ethers.id("raffy")
	)
);
