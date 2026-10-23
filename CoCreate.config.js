module.exports = {
	organization_id: "",
	key: "",
	host: "",
	sources: [
		{
			array: "files",
			object: {
				name: "index.html",
				path: "/docs/markdown",
				pathname: "/docs/markdown/index.html",
				src: "{{./docs/index.html}}",
				host: ["*"],
				directory: "markdown",
				"content-type": "{{content-type}}",
				public: "true"
			}
		}
	]
};
