import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import MiniCssExtractPlugin from "mini-css-extract-plugin";
import { EsbuildPlugin } from "esbuild-loader";
import webpackPackage from "@cocreate/webpack";

const { FileUploader } = webpackPackage;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localPrototype = path.resolve(__dirname, "../CoCreate-element-prototype");

export default async (env, argv) => {
	const isProduction = argv && argv.mode === "production";
	const config = {
		resolve: {
			alias: existsSync(localPrototype)
				? { "@cocreate/element-prototype": localPrototype }
				: {}
		},
		entry: {
			"CoCreate-editor": "./src/index.js"
		},
		output: {
			path: path.resolve(__dirname, "dist"),
			filename: isProduction ? "[name].min.js" : "[name].js",
			chunkFilename: isProduction ? "[name].min.js" : "[name].js",
			library: { name: ["CoCreate", "editor"], type: "window", export: "default" },
			clean: true
		},
		plugins: [
			new MiniCssExtractPlugin({
				filename: isProduction ? "[name].min.css" : "[name].css"
			}),
			new FileUploader(env, argv)
		],
		mode: isProduction ? "production" : "development",
		devtool: isProduction ? "source-map" : "eval-source-map",
		module: {
			rules: [
				{
					test: /.js$/,
					exclude: /node_modules/,
					use: {
						loader: "esbuild-loader",
						options: {
							loader: "js",
							target: "es2017"
						}
					}
				},
				{
					test: /.css$/i,
					use: [MiniCssExtractPlugin.loader, "css-loader"]
				}
			]
		},
		optimization: {
			minimize: isProduction,
			minimizer: [
			new EsbuildPlugin({
				target: "es2017",
				minify: true
			})
			]
		},
		performance: {
			hints: isProduction ? "warning" : false
		}
	};
	return config;
};
